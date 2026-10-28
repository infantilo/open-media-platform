package alertsink

import (
	"context"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

func drain(s *Sink) []Alert {
	var out []Alert
	for len(s.queue) > 0 {
		out = append(out, <-s.queue)
	}
	return out
}

func health(id, label string, ready *bool) sse.Event {
	d := `{"node_id":"` + id + `","label":"` + label + `","status":"ok"`
	if ready != nil {
		if *ready {
			d += `,"media_ready":true`
		} else {
			d += `,"media_ready":false`
		}
	}
	return sse.Event{Type: "omp.health." + id, Data: []byte(d + "}")}
}

func TestMediaLostAfterGraceAndRecovery(t *testing.T) {
	s := New("http://x.invalid", "")
	s.Debounce = 0
	now := time.Unix(1000, 0)
	w := &HealthWatch{Sink: s, MediaGrace: 15 * time.Second, Silence: time.Hour, Now: func() time.Time { return now }}
	w.defaults()
	nodes := map[string]*nodeHealth{}
	yes, no := true, false

	w.observe(nodes, health("n1", "PGM", &no)) // Start: noch nie bereit → kein Alarm
	now = now.Add(time.Minute)
	w.evaluate(nodes)
	if len(drain(s)) != 0 {
		t.Fatal("ein Node, der noch nie bereit war, alarmiert nicht (Start)")
	}
	w.observe(nodes, health("n1", "PGM", &yes))
	w.observe(nodes, health("n1", "PGM", &no))
	now = now.Add(10 * time.Second)
	w.evaluate(nodes)
	if len(drain(s)) != 0 {
		t.Fatal("innerhalb der Karenzzeit kein Alarm")
	}
	now = now.Add(6 * time.Second)
	w.evaluate(nodes)
	got := drain(s)
	if len(got) != 1 || got[0].Kind != "media-lost" || got[0].Name != "PGM" {
		t.Fatalf("%+v", got)
	}
	w.evaluate(nodes)
	if len(drain(s)) != 0 {
		t.Fatal("nur einmal melden")
	}
	w.observe(nodes, health("n1", "PGM", &yes))
	if got := drain(s); len(got) != 1 || got[0].Kind != "media-recovered" {
		t.Fatalf("%+v", got)
	}
}

func TestShortGlitchBelowGraceIsSilent(t *testing.T) {
	s := New("http://x.invalid", "")
	now := time.Unix(1000, 0)
	w := &HealthWatch{Sink: s, Now: func() time.Time { return now }}
	w.defaults()
	nodes := map[string]*nodeHealth{}
	yes, no := true, false
	w.observe(nodes, health("n1", "A", &yes))
	w.observe(nodes, health("n1", "A", &no))
	now = now.Add(5 * time.Second)
	w.observe(nodes, health("n1", "A", &yes))
	now = now.Add(time.Minute)
	w.observe(nodes, health("n1", "A", &yes))
	w.evaluate(nodes)
	if got := drain(s); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestSilentNodeAndReturn(t *testing.T) {
	s := New("http://x.invalid", "")
	s.Debounce = 0
	now := time.Unix(1000, 0)
	w := &HealthWatch{Sink: s, Silence: 30 * time.Second, Now: func() time.Time { return now }}
	w.defaults()
	nodes := map[string]*nodeHealth{}
	w.observe(nodes, health("n9", "Kamera", nil))
	now = now.Add(31 * time.Second)
	w.evaluate(nodes)
	if got := drain(s); len(got) != 1 || got[0].Kind != "node-silent" {
		t.Fatalf("%+v", got)
	}
	w.observe(nodes, health("n9", "Kamera", nil))
	if got := drain(s); len(got) != 1 || got[0].Kind != "node-recovered" {
		t.Fatalf("%+v", got)
	}
}

func TestLoadSustained(t *testing.T) {
	s := New("http://x.invalid", "")
	s.Debounce = 0
	cur := map[string]Load{"h": {Name: "A", CPUPercent: 99, MemPercent: 10}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go WatchLoad(ctx, 10*time.Millisecond, 400*time.Millisecond, 95, 95, 0, func() map[string]Load { return map[string]Load{"h": cur["h"]} }, s)
	time.Sleep(100 * time.Millisecond)
	if len(s.queue) != 0 {
		t.Fatal("zu kurz für Alarm")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(s.queue) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	got := drain(s)
	if len(got) != 1 || got[0].Kind != "load-high" || got[0].Subject != "h/CPU" {
		t.Fatalf("%+v", got)
	}
}

func TestLoadTemperatureAlertsOnlyWhenMeasured(t *testing.T) {
	s := New("http://x.invalid", "")
	s.Debounce = 0
	// h1 heiß, h2 ohne Sensor (TempC 0 = nicht gemessen → nie ein Alarm).
	cur := map[string]Load{"h1": {Name: "Heiß", TempC: 91}, "h2": {Name: "Ohne Sensor"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go WatchLoad(ctx, 10*time.Millisecond, 100*time.Millisecond, 95, 95, 85, func() map[string]Load { return cur }, s)
	deadline := time.Now().Add(3 * time.Second)
	for len(s.queue) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)
	got := drain(s)
	if len(got) != 1 || got[0].Kind != "load-high" || got[0].Subject != "h1/Temperatur" {
		t.Fatalf("nur der heiße Host mit Sensor alarmiert: %+v", got)
	}
}

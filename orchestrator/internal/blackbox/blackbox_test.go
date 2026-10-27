package blackbox

import (
	"fmt"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

func b(v bool) *bool { return &v }

func TestDownsamplesButKeepsReadinessChanges(t *testing.T) {
	r := New()
	r.now = func() time.Time { return t0.Add(time.Minute) }
	r.Record("n1", "Kamera", b(true), map[string]float64{"video_fps": 25}, t0)
	r.Record("n1", "Kamera", b(true), map[string]float64{"video_fps": 25}, t0.Add(time.Second))    // zu dicht: entfällt
	r.Record("n1", "Kamera", b(false), map[string]float64{"video_fps": 0}, t0.Add(2*time.Second))  // Wechsel: immer
	r.Record("n1", "Kamera", b(false), map[string]float64{"video_fps": 0}, t0.Add(10*time.Second)) // Abstand reicht
	s := r.Window(5 * time.Minute)
	if len(s.Nodes) != 1 || len(s.Nodes[0].Samples) != 3 || s.Nodes[0].Label != "Kamera" {
		t.Fatalf("%+v", s.Nodes)
	}
	if s.Nodes[0].Samples[1].Ready == nil || *s.Nodes[0].Samples[1].Ready || s.Nodes[0].Samples[1].KPIs["video_fps"] != 0 {
		t.Errorf("Wechsel nicht gespeichert: %+v", s.Nodes[0].Samples[1])
	}
}

func TestWindowAndRetention(t *testing.T) {
	r := New()
	now := t0.Add(399 * 5 * time.Second) // Zeitpunkt des letzten Punkts
	r.now = func() time.Time { return now }
	for i := 0; i < 400; i++ { // alle 5 s über 33 Minuten
		r.Record("n1", "A", b(true), nil, t0.Add(time.Duration(i)*5*time.Second))
	}
	all := r.Window(time.Hour) // gedeckelt auf Window (15 min)
	if got := all.To.Sub(all.From); got != Window {
		t.Fatalf("Fenster %v", got)
	}
	first := all.Nodes[0].Samples[0].T
	if now.Sub(first) > Window {
		t.Errorf("zu alter Punkt: %v", now.Sub(first))
	}
	short := r.Window(2 * time.Minute)
	if n := len(short.Nodes[0].Samples); n < 20 || n > 30 {
		t.Errorf("2 Minuten à 5 s ≈ 24 Punkte, hier %d", n)
	}
	// Speicher bleibt begrenzt: höchstens Window/Interval + 1 Punkte je Reihe
	r.mu.Lock()
	n := len(r.nodes["n1"].samples)
	r.mu.Unlock()
	if n > int(Window/Interval)+2 {
		t.Errorf("Reihe wächst: %d", n)
	}
	// Reihen, die nichts mehr im Fenster haben, fehlen
	now = t0.Add(3 * time.Hour)
	if got := r.Window(time.Minute); len(got.Nodes) != 0 {
		t.Errorf("veraltet: %+v", got.Nodes)
	}
}

func TestProcSamplesAndSeriesLimit(t *testing.T) {
	r := New()
	r.now = func() time.Time { return t0.Add(time.Minute) }
	cpu, rss := 42.5, uint64(1<<20)
	r.RecordProc("i1", "Mixer", &cpu, &rss, t0)
	r.RecordProc("i1", "Mixer", &cpu, &rss, t0.Add(time.Second)) // zu dicht
	r.RecordProc("i1", "Mixer", nil, nil, t0.Add(6*time.Second))
	s := r.Window(10 * time.Minute)
	if len(s.Procs) != 1 || len(s.Procs[0].Samples) != 2 || *s.Procs[0].Samples[0].CPU != 42.5 || s.Procs[0].Samples[1].CPU != nil {
		t.Fatalf("%+v", s.Procs)
	}
	for i := 0; i < maxSeries+50; i++ {
		r.Record(fmt.Sprintf("n%d", i), "x", nil, nil, t0)
	}
	r.mu.Lock()
	n := len(r.nodes)
	r.mu.Unlock()
	if n > maxSeries {
		t.Errorf("Zahl der Reihen unbegrenzt: %d", n)
	}
}

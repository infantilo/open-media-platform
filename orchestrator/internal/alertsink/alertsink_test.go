package alertsink

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

func TestFromEvent(t *testing.T) {
	a, ok := FromEvent(sse.Event{Type: "omp.alert.n1", Data: []byte(`{"node_id":"n1","message":"Pipeline gerissen"}`)})
	if !ok || a.Kind != "node-alert" || a.Subject != "n1" || a.Message != "Pipeline gerissen" {
		t.Fatalf("%+v %v", a, ok)
	}
	if _, ok := FromEvent(sse.Event{Type: "omp.health.n1"}); ok {
		t.Fatal("nur Alarme")
	}
	if a, _ := FromEvent(sse.Event{Type: "omp.alert.n2", Data: []byte(`kein json`)}); a.Message != "kein json" {
		t.Fatalf("%+v", a)
	}
}

func TestNilSinkIsHarmless(t *testing.T) {
	var s *Sink
	s.Send(Alert{})
	s.Run(context.Background())
	if New("  ", "") != nil {
		t.Fatal("ohne URL kein Sink")
	}
}

func TestDeliversWithTokenAndDebounces(t *testing.T) {
	var mu sync.Mutex
	var got []Alert
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a Alert
		_ = json.NewDecoder(r.Body).Decode(&a)
		mu.Lock()
		got, auth = append(got, a), r.Header.Get("Authorization")
		mu.Unlock()
	}))
	defer srv.Close()
	s := New(srv.URL, "tok")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	for i := 0; i < 5; i++ {
		s.Send(Alert{Kind: "node-alert", Subject: "n1", Message: "gleich"})
	}
	s.Send(Alert{Kind: "node-alert", Subject: "n1", Message: "anders"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("5 gleiche → 1, dazu 1 andere: %d", len(got))
	}
	if auth != "Bearer tok" || got[0].Text == "" || got[0].Time.IsZero() {
		t.Fatalf("auth=%q %+v", auth, got[0])
	}
}

func TestRetriesThenGivesUp(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			http.Error(w, "nein", 500)
		}
	}))
	defer srv.Close()
	s := New(srv.URL, "")
	s.Retry = []time.Duration{5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond}
	s.deliver(context.Background(), Alert{Kind: "x"})
	if calls.Load() != 3 {
		t.Fatalf("zwei Fehlschläge, dritter Erfolg: %d", calls.Load())
	}
	calls.Store(-100) // immer 500
	s.deliver(context.Background(), Alert{Kind: "x"})
	if calls.Load() != -100+4 {
		t.Fatalf("1 + 3 Wiederholungen: %d", calls.Load()+100)
	}
}

func TestWatchHostsReportsTransitionsOnly(t *testing.T) {
	var mu sync.Mutex
	state := map[string]HostState{"h1": {Name: "Regie A", Online: false}}
	snap := func() map[string]HostState {
		mu.Lock()
		defer mu.Unlock()
		out := map[string]HostState{}
		for k, v := range state {
			out[k] = v
		}
		return out
	}
	s := New("http://x.invalid", "")
	s.Debounce = 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go WatchHosts(ctx, 10*time.Millisecond, snap, s)
	time.Sleep(40 * time.Millisecond) // Ausgangszustand: offline, kein Alarm
	if len(s.queue) != 0 {
		t.Fatal("Ausgangszustand erzeugt keinen Alarm")
	}
	set := func(on bool) {
		mu.Lock()
		state["h1"] = HostState{Name: "Regie A", Online: on}
		mu.Unlock()
	}
	set(true)
	time.Sleep(40 * time.Millisecond)
	set(false)
	time.Sleep(40 * time.Millisecond)
	var kinds []string
	for len(s.queue) > 0 {
		kinds = append(kinds, (<-s.queue).Kind)
	}
	if len(kinds) != 2 || kinds[0] != "host-online" || kinds[1] != "host-offline" {
		t.Fatalf("%v", kinds)
	}
}

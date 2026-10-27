package kpi

import (
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

func b(v bool) *bool { return &v }

func feed(t *Tracker, id string, start time.Time, seconds int, ready bool) time.Time {
	at := start
	for i := 0; i < seconds; i += 5 { // alle 5 s ein Ereignis wie ein echter Node
		t.Observe(id, "PGM", b(ready), at)
		at = at.Add(5 * time.Second)
	}
	return at
}

func TestAvailabilityAndOutages(t *testing.T) {
	tr := NewTracker()
	t0 := time.Unix(1_800_000_000, 0)
	tr.now = func() time.Time { return t0.Add(120 * time.Second) }
	at := feed(tr, "n1", t0, 60, true)   // 60 s bereit
	at = feed(tr, "n1", at, 20, false)   // 20 s Ausfall
	at = feed(tr, "n1", at, 40, true)    // wieder 40 s bereit
	tr.Observe("n1", "PGM", b(true), at) // letztes Ereignis schließt das Intervall

	k := tr.Snapshot(time.Hour)[0]
	if k.Availability == nil || *k.Availability < 0.80 || *k.Availability > 0.86 {
		t.Fatalf("Verfügbarkeit ~100/120: %+v", k.Availability)
	}
	if k.Outages != 1 || k.LongestOutageS < 18 || k.LongestOutageS > 25 || k.LastOutage == nil || k.LastOutage.Ongoing {
		t.Fatalf("Ausfall: %+v", k)
	}
	if !k.CurrentlyReady || k.Label != "PGM" {
		t.Fatalf("%+v", k)
	}
}

func TestOngoingOutageAndGapsAreNotObserved(t *testing.T) {
	tr := NewTracker()
	t0 := time.Unix(1_800_000_000, 0)
	tr.Observe("n1", "A", b(true), t0)
	tr.Observe("n1", "A", b(true), t0.Add(5*time.Second))
	// 10 Minuten Schweigen: nicht beobachtet, nicht als Ausfall gezählt.
	tr.Observe("n1", "A", b(true), t0.Add(10*time.Minute))
	tr.Observe("n1", "A", b(false), t0.Add(10*time.Minute+5*time.Second))
	tr.now = func() time.Time { return t0.Add(10*time.Minute + 65*time.Second) }
	k := tr.Snapshot(time.Hour)[0]
	if k.ObservedSeconds > 15 {
		t.Fatalf("Lücke darf nicht zählen: %v", k.ObservedSeconds)
	}
	if k.CurrentlyReady || k.Outages != 1 || k.LastOutage == nil || !k.LastOutage.Ongoing || k.LastOutage.Seconds < 55 {
		t.Fatalf("laufender Ausfall: %+v", k)
	}
}

func TestNeverReadyIsNoOutageAndNoDataHasNilAvailability(t *testing.T) {
	tr := NewTracker()
	t0 := time.Unix(1_800_000_000, 0)
	tr.Observe("n1", "A", b(false), t0)
	tr.Observe("n1", "A", b(false), t0.Add(5*time.Second))
	tr.now = func() time.Time { return t0.Add(10 * time.Second) }
	k := tr.Snapshot(time.Hour)[0]
	if k.Outages != 0 {
		t.Fatal("Start ohne je bereit zu sein ist kein Ausfall")
	}
	tr.Observe("n2", "B", nil, t0) // ohne media_ready ignoriert
	if len(tr.Snapshot(time.Hour)) != 1 {
		t.Fatal("Node ohne media_ready nicht aufnehmen")
	}
}

func TestWindowAndSorting(t *testing.T) {
	tr := NewTracker()
	t0 := time.Unix(1_800_000_000, 0)
	feed(tr, "good", t0, 60, true)
	at := feed(tr, "bad", t0, 30, true)
	feed(tr, "bad", at, 30, false)
	tr.now = func() time.Time { return t0.Add(61 * time.Second) }
	s := tr.Snapshot(time.Hour)
	if s[0].NodeID != "bad" || s[1].NodeID != "good" {
		t.Fatalf("schlechteste Verfügbarkeit zuerst: %v %v", s[0].NodeID, s[1].NodeID)
	}
	tr.now = func() time.Time { return t0.Add(3 * time.Hour) }
	for _, k := range tr.Snapshot(time.Hour) {
		if k.ObservedSeconds != 0 {
			t.Fatalf("außerhalb des Fensters: %+v", k)
		}
	}
	tr.Forget("bad")
	if len(tr.Snapshot(time.Hour)) != 1 {
		t.Fatal("Forget")
	}
}

func TestFromEvent(t *testing.T) {
	id, label, r, ok := FromEvent(sse.Event{Type: "omp.health.n7", Data: []byte(`{"label":"X","media_ready":true}`)})
	if !ok || id != "n7" || label != "X" || r == nil || !*r {
		t.Fatal("health")
	}
	if _, _, _, ok := FromEvent(sse.Event{Type: "omp.health.n7", Data: []byte(`{"label":"X"}`)}); ok {
		t.Fatal("ohne media_ready")
	}
	if _, _, _, ok := FromEvent(sse.Event{Type: "omp.alert.n7", Data: []byte(`{}`)}); ok {
		t.Fatal("kein Health")
	}
}

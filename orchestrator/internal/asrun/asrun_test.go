package asrun

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func tp(t time.Time) *time.Time { return &t }

func TestUpsertIsIdempotentAndUpdatesRunningToFinal(t *testing.T) {
	db := dbtest.Open(t)
	m := NewMetrics()
	s := NewStore(db, m)
	ctx := context.Background()
	start := time.Now().Add(-time.Minute).UTC().Truncate(time.Millisecond)
	plan := start.Add(-1500 * time.Millisecond)
	dur := int64(8000)
	running := Record{Key: "e1#1", Kind: KindPrimary, EventID: "e1", Label: "Clip", PlannedStart: tp(plan), ActualStart: tp(start), PlannedDurationMs: &dur, Status: StatusRunning, Mode: "auto"}
	if err := s.Upsert(ctx, "chan-asrun-1", []Record{running}); err != nil {
		t.Fatal(err)
	}
	final := running
	final.Status, final.Reason, final.ActualEnd = StatusCompleted, "auto", tp(start.Add(8*time.Second))
	for i := 0; i < 2; i++ { // doppelte Lieferung
		if err := s.Upsert(ctx, "chan-asrun-1", []Record{final}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.List(ctx, Filter{ChannelID: "chan-asrun-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Status != StatusCompleted || got[0].ActualEnd == nil || got[0].Reason != "auto" {
		t.Fatalf("eine Zeile mit Endstatus erwartet, bekam %+v", got)
	}
	var b strings.Builder
	m.WritePrometheus(&b)
	out := b.String()
	for _, want := range []string{
		`omp_playout_events_total{channel="chan-asrun-1",status="COMPLETED"} 1`,
		`omp_playout_event_start_lateness_seconds_count{channel="chan-asrun-1"} 1`,
		`omp_playout_event_duration_seconds_count{channel="chan-asrun-1"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Kennzahl fehlt: %s\n%s", want, out)
		}
	}
}

func TestListFiltersAndCSV(t *testing.T) {
	db := dbtest.Open(t)
	s := NewStore(db, nil)
	ctx := context.Background()
	now := time.Now().UTC()
	recs := []Record{
		{Key: "a", Kind: KindPrimary, Label: "A, mit Komma", Status: StatusCompleted, RecordedAt: now.Add(-2 * time.Hour)},
		{Key: "b", Kind: KindOperator, Action: "take", Operator: "alice", RecordedAt: now.Add(-time.Hour)},
		{Key: "c", Kind: KindChild, ChildID: "c1", Status: "FAILED", RecordedAt: now},
	}
	if err := s.Upsert(ctx, "chan-asrun-2", recs); err != nil {
		t.Fatal(err)
	}
	ops, _ := s.List(ctx, Filter{ChannelID: "chan-asrun-2", Kind: KindOperator})
	if len(ops) != 1 || ops[0].Operator != "alice" {
		t.Fatalf("Operator-Filter: %+v", ops)
	}
	recent, _ := s.List(ctx, Filter{ChannelID: "chan-asrun-2", From: now.Add(-90 * time.Minute)})
	if len(recent) != 2 || recent[0].Key != "c" {
		t.Fatalf("Zeitfilter/Reihenfolge: %+v", recent)
	}
	all, _ := s.List(ctx, Filter{ChannelID: "chan-asrun-2"})
	var buf bytes.Buffer
	if err := WriteCSV(&buf, all); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"A, mit Komma"`) || strings.Count(buf.String(), "\n") != 4 {
		t.Fatalf("CSV unerwartet:\n%s", buf.String())
	}
	n, err := s.Prune(ctx, now.Add(-90*time.Minute))
	if err != nil || n != 1 {
		t.Fatalf("Prune: %d %v", n, err)
	}
}

func TestValidation(t *testing.T) {
	db := dbtest.Open(t)
	s := NewStore(db, nil)
	if err := s.Upsert(context.Background(), "x", []Record{{Key: "", Kind: KindPrimary}}); err == nil {
		t.Fatal("leerer Schlüssel muss abgelehnt werden")
	}
	if err := s.Upsert(context.Background(), "x", []Record{{Key: "k", Kind: "unbekannt"}}); err == nil {
		t.Fatal("unbekannte Art muss abgelehnt werden")
	}
}

func TestMetricsCountEachFinishOnceAndClassifyEarlyStarts(t *testing.T) {
	m := NewMetrics()
	now := time.Now()
	early := Record{Key: "k1", Kind: KindPrimary, Status: StatusRunning, PlannedStart: tp(now.Add(2 * time.Second)), ActualStart: tp(now)}
	m.Observe("c", early)
	m.Observe("c", early)
	m.Observe("c", Record{Key: "w", Kind: KindWarning, Action: "source_resolution"})
	m.Observe("c", Record{Key: "ch", Kind: KindChild, Status: "FAILED"})
	m.Observe("c", Record{Key: "ch", Kind: KindChild, Status: "FAILED"})
	m.ObserveTriggerLatency("c", 0.3)
	var b strings.Builder
	m.WritePrometheus(&b)
	out := b.String()
	for _, want := range []string{
		`omp_playout_event_start_early_seconds_count{channel="c"} 1`,
		`omp_playout_source_resolution_failures_total{channel="c"} 1`,
		`omp_playout_child_event_failures_total{channel="c"} 1`,
		`omp_playout_channel_trigger_latency_seconds_bucket{channel="c",le="1"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("fehlt: %s\n%s", want, out)
		}
	}
	if strings.Contains(out, "lateness_seconds_count") {
		t.Errorf("zu früher Start darf nicht als Verspätung zählen:\n%s", out)
	}
}

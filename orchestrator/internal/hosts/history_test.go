package hosts

import (
	"testing"
	"time"
)

func metricsAt(t time.Time, cpu float64, used, total uint64) Metrics {
	return Metrics{CPUPercent: cpu, MemUsedBytes: used, MemTotalBytes: total, ReceivedAt: t}
}

func TestHistoryWindowUnknownHost(t *testing.T) {
	h := NewHistory()
	if _, ok := h.Window("host-1", time.Hour); ok {
		t.Fatalf("Window() ok = true for a host that never reported telemetry")
	}
}

func TestHistoryRawWindowReturnsSamplesWithinCutoff(t *testing.T) {
	h := NewHistory()
	base := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)

	// Drei Samples über 20 Minuten verteilt — eine 10-Minuten-Abfrage
	// darf nur die letzten beiden sehen.
	h.Record("host-1", metricsAt(base, 10, 100, 1000))
	h.Record("host-1", metricsAt(base.Add(10*time.Minute), 20, 200, 1000))
	h.Record("host-1", metricsAt(base.Add(20*time.Minute), 30, 300, 1000))

	// Window() schneidet relativ zu time.Now(), nicht zu den
	// eingespeisten Zeitstempeln — hier reicht es, alle drei mit einem
	// großzügigen Fenster zu sehen und die Reihenfolge/Werte zu prüfen.
	win, ok := h.Window("host-1", rawWindow)
	if !ok {
		t.Fatalf("Window() ok = false")
	}
	if win.Resolution != "raw" {
		t.Errorf("Resolution = %q, want raw", win.Resolution)
	}
	if len(win.Samples) != 3 {
		t.Fatalf("Samples = %d, want 3", len(win.Samples))
	}
	if win.Summary.CPUMin != 10 || win.Summary.CPUMax != 30 || win.Summary.CPUAvg != 20 {
		t.Errorf("Summary = %+v, want min=10 avg=20 max=30", win.Summary)
	}
	if win.Summary.MemMin != 10 || win.Summary.MemMax != 30 {
		// MemPercent = used/total*100 -> 10/20/30 aus den obigen Werten.
		t.Errorf("Summary mem = %+v, want min=10 max=30", win.Summary)
	}
}

func TestHistoryRawCapacityTrims(t *testing.T) {
	h := NewHistory()
	base := time.Now().Add(-2 * rawWindow)
	for i := 0; i < rawCapacity+50; i++ {
		h.Record("host-1", metricsAt(base.Add(time.Duration(i)*rawSampleInterval), float64(i), 1, 1))
	}
	win, ok := h.Window("host-1", rawWindow)
	if !ok {
		t.Fatalf("Window() ok = false")
	}
	if len(win.Samples) > rawCapacity {
		t.Errorf("Samples = %d, want <= rawCapacity (%d)", len(win.Samples), rawCapacity)
	}
}

func TestHistoryAggregatesCloseOnBucketBoundary(t *testing.T) {
	h := NewHistory()
	// base muss innerhalb des unten abgefragten Fensters liegen (Window()
	// schneidet relativ zu time.Now(), nicht zu den Test-Zeitstempeln).
	base := time.Now().Add(-90 * time.Minute).Truncate(time.Minute)

	// Erster Eimer: zwei Samples (10, 20) -> min 10, max 20, avg 15.
	h.Record("host-1", metricsAt(base, 10, 0, 100))
	h.Record("host-1", metricsAt(base.Add(30*time.Second), 20, 0, 100))
	// Zweiter Eimer beginnt -> schließt den ersten ab.
	h.Record("host-1", metricsAt(base.Add(time.Minute), 30, 0, 100))
	h.Record("host-1", metricsAt(base.Add(90*time.Second), 40, 0, 100))
	// Dritter Eimer beginnt -> schließt den zweiten ab. Der dritte
	// bleibt offen (nicht in Aggregates enthalten).
	h.Record("host-1", metricsAt(base.Add(2*time.Minute), 50, 0, 100))

	win, ok := h.Window("host-1", 2*time.Hour)
	if !ok {
		t.Fatalf("Window() ok = false")
	}
	if win.Resolution != "aggregate" {
		t.Errorf("Resolution = %q, want aggregate", win.Resolution)
	}
	if len(win.Aggregates) != 2 {
		t.Fatalf("Aggregates = %d, want 2 (offener dritter Eimer bleibt ausgeschlossen): %+v", len(win.Aggregates), win.Aggregates)
	}
	first, second := win.Aggregates[0], win.Aggregates[1]
	if first.CPUMin != 10 || first.CPUMax != 20 || first.CPUAvg != 15 || first.SampleCount != 2 {
		t.Errorf("first bucket = %+v, want min=10 max=20 avg=15 count=2", first)
	}
	if second.CPUMin != 30 || second.CPUMax != 40 || second.CPUAvg != 35 || second.SampleCount != 2 {
		t.Errorf("second bucket = %+v, want min=30 max=40 avg=35 count=2", second)
	}
	if win.Summary.CPUMin != 10 || win.Summary.CPUMax != 40 {
		t.Errorf("Summary = %+v, want min=10 max=40 across both buckets", win.Summary)
	}
	wantAvg := (15.0*2 + 35.0*2) / 4.0
	if win.Summary.CPUAvg != wantAvg {
		t.Errorf("Summary.CPUAvg = %v, want %v (sample-count-weighted)", win.Summary.CPUAvg, wantAvg)
	}
}

func TestHistoryAggregateCapacityTrims(t *testing.T) {
	h := NewHistory()
	base := time.Now().Add(-2 * aggregateWindow)
	for i := 0; i < aggregateCapacity+10; i++ {
		h.Record("host-1", metricsAt(base.Add(time.Duration(i)*aggregateBucket), float64(i), 1, 1))
	}
	win, ok := h.Window("host-1", aggregateWindow)
	if !ok {
		t.Fatalf("Window() ok = false")
	}
	if len(win.Aggregates) > aggregateCapacity {
		t.Errorf("Aggregates = %d, want <= aggregateCapacity (%d)", len(win.Aggregates), aggregateCapacity)
	}
}

func TestHistoryWindowClampsToSupportedRange(t *testing.T) {
	h := NewHistory()
	h.Record("host-1", metricsAt(time.Now(), 5, 1, 2))

	if win, ok := h.Window("host-1", 0); !ok || win.Resolution != "raw" {
		t.Errorf("Window(0) = %+v, ok=%v, want clamped to >=1m raw window", win, ok)
	}
	if win, ok := h.Window("host-1", 999*time.Hour); !ok || win.Resolution != "aggregate" {
		t.Errorf("Window(999h) = %+v, ok=%v, want clamped to <=24h aggregate window", win, ok)
	}
}

package hosts

import (
	"context"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"sync"
	"testing"
	"time"
)

func metricAt(t time.Time, liveCoresPct float64) Metrics {
	return Metrics{CPUPercent: 40, MemUsedBytes: 4 << 30, MemTotalBytes: 16 << 30, ReceivedAt: t,
		Instances: []InstanceMetrics{{InstanceID: "a", CPUPercent: liveCoresPct, RSSBytes: 2 << 30}}}
}

func TestStundenwerteUndLiveBedarf(t *testing.T) {
	h := NewHistory()
	var mu sync.Mutex
	var rows []HourRow
	h.OnHour = func(_ string, r HourRow) { mu.Lock(); rows = append(rows, r); mu.Unlock() }
	start := time.Now().Add(-3 * time.Hour).Truncate(time.Hour).Add(10 * time.Minute)
	n := 0
	for ts := start; ts.Before(time.Now()); ts = ts.Add(5 * time.Second) {
		live := 100.0 // 1 Kern
		if n%360 == 0 {
			live = 400 // seltene Spitze: 4 Kerne
		}
		h.Record("h1", metricAt(ts, live))
		n++
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	nr := len(rows)
	mu.Unlock()
	if nr < 2 {
		t.Fatalf("abgeschlossene Stunden: %d", nr)
	}
	d, ok := h.LiveDemand("h1", 7*24*time.Hour)
	if !ok || d.Span < 2*time.Hour {
		t.Fatalf("%+v %v", d, ok)
	}
	if d.CPUPeak < 3.9 || d.CPUP95 > 1.5 || d.CPUP95 < 0.9 {
		t.Fatalf("Spitze 4 Kerne, P95 ≈ 1 Kern: %+v", d)
	}
	if d.MemPeak < 12 || d.MemPeak > 13 {
		t.Fatalf("2 GiB von 16 GiB = 12,5 %%: %+v", d)
	}
	w, ok := h.Window("h1", 3*24*time.Hour)
	if !ok || w.Resolution != "hourly" || len(w.Hours) < 2 || w.Summary.SampleCount == 0 {
		t.Fatalf("%+v", w.Resolution)
	}
	if w2, _ := h.Window("h1", 30*time.Minute); w2.Resolution != "raw" || len(w2.Samples) == 0 || w2.Samples[0].LiveCPUCores == 0 {
		t.Fatal("Rohdaten tragen den Live-Anteil")
	}
	// Seed: gespeicherte Stunden vor den neuen
	h2 := NewHistory()
	h2.Seed("h1", []HourRow{{Hour: time.Now().Add(-48 * time.Hour).Truncate(time.Hour), Samples: 720, CPUAvg: 30, ExtraMax: ExtraMax{LiveCPUCoresMax: 6}}})
	if d2, ok := h2.LiveDemand("h1", 7*24*time.Hour); !ok || d2.CPUPeak != 6 {
		t.Fatalf("%+v %v", d2, ok)
	}
}

func TestPercentile(t *testing.T) {
	if percentile(nil, 0.95) != 0 || percentile([]float64{1, 2, 3, 4, 100}, 0.95) != 100 || percentile([]float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, 0.5) != 5 {
		t.Fatal("percentile")
	}
}

func TestStundenwerteInPostgres(t *testing.T) {
	database := dbtest.Open(t)
	s := NewHourStore(database)
	h0 := time.Now().Add(-5 * time.Hour).Truncate(time.Hour)
	for i := 0; i < 3; i++ {
		r := HourRow{Hour: h0.Add(time.Duration(i) * time.Hour), CPUAvg: 20 + float64(i), CPUMax: 80, MemAvg: 30, MemMax: 40, Samples: 700, LiveCPUCoresP95: 1.5, LiveCPUCoresAvg: 1, ExtraMax: ExtraMax{LiveCPUCoresMax: 3, LiveMemMax: 12, LiveGPUMax: 5, GPUMax: 9, NetMax: 4}}
		if err := s.Save("h-trend", r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Save("h-trend", HourRow{Hour: h0, CPUAvg: 99, Samples: 1}); err != nil { // Upsert
		t.Fatal(err)
	}
	got, err := s.Load(context.Background(), time.Now().Add(-24*time.Hour))
	if err != nil || len(got["h-trend"]) != 3 || got["h-trend"][0].CPUAvg != 99 || got["h-trend"][1].LiveCPUCoresMax != 3 || got["h-trend"][2].NetMax != 4 {
		t.Fatalf("%v %+v", err, got["h-trend"])
	}
	h := NewHistory()
	h.Seed("h-trend", got["h-trend"])
	if d, ok := h.LiveDemand("h-trend", 7*24*time.Hour); !ok || d.CPUPeak != 3 {
		t.Fatalf("%+v %v", d, ok)
	}
}

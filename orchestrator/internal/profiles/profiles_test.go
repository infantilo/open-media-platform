package profiles

import (
	"testing"
	"time"
)

func TestComputeSnapshotEmpty(t *testing.T) {
	snap := computeSnapshot("omp-video-mixer-me", "", nil, time.Now())
	if snap.SampleCount != 0 {
		t.Errorf("SampleCount = %d, want 0", snap.SampleCount)
	}
}

func TestComputeSnapshotMinAvgMaxP95(t *testing.T) {
	now := time.Now()
	var samples []Sample
	// 10, 20, 30, ..., 100 — CPU% zwecks einfacher Nachrechenbarkeit.
	for i := 1; i <= 10; i++ {
		samples = append(samples, Sample{
			Timestamp:  now,
			CPUPercent: float64(i * 10),
			RSSBytes:   uint64(i * 1_000_000),
		})
	}

	snap := computeSnapshot("omp-video-mixer-me", "host-a", samples, now)

	if snap.SampleCount != 10 {
		t.Errorf("SampleCount = %d, want 10", snap.SampleCount)
	}
	if snap.CPUMin != 10 || snap.CPUMax != 100 {
		t.Errorf("CPUMin/Max = %v/%v, want 10/100", snap.CPUMin, snap.CPUMax)
	}
	if snap.CPUAvg != 55 {
		t.Errorf("CPUAvg = %v, want 55", snap.CPUAvg)
	}
	// nearest-rank p95 von 10 aufsteigend sortierten Werten: ceil(0.95*10)-1 = 9 -> Index 9 -> 100.
	if snap.CPUP95 != 100 {
		t.Errorf("CPUP95 = %v, want 100", snap.CPUP95)
	}
	if snap.RSSMin != 1_000_000 || snap.RSSMax != 10_000_000 {
		t.Errorf("RSSMin/Max = %v/%v, want 1000000/10000000", snap.RSSMin, snap.RSSMax)
	}
	if snap.RSSAvg != 5_500_000 {
		t.Errorf("RSSAvg = %v, want 5500000", snap.RSSAvg)
	}
}

func TestComputeSnapshotSingleSample(t *testing.T) {
	now := time.Now()
	snap := computeSnapshot("t", "h", []Sample{{Timestamp: now, CPUPercent: 42, RSSBytes: 123}}, now)
	if snap.CPUMin != 42 || snap.CPUAvg != 42 || snap.CPUMax != 42 || snap.CPUP95 != 42 {
		t.Errorf("single-sample snapshot should have min=avg=max=p95=42, got %+v", snap)
	}
	if snap.RSSMin != 123 || snap.RSSAvg != 123 || snap.RSSMax != 123 {
		t.Errorf("single-sample RSS should all be 123, got %+v", snap)
	}
}

func TestTrimBefore(t *testing.T) {
	base := time.Now()
	samples := []Sample{
		{Timestamp: base.Add(-20 * time.Minute)},
		{Timestamp: base.Add(-10 * time.Minute)},
		{Timestamp: base.Add(-1 * time.Minute)},
	}
	trimmed := trimBefore(samples, base.Add(-15*time.Minute))
	if len(trimmed) != 2 {
		t.Fatalf("trimBefore() len = %d, want 2", len(trimmed))
	}
	if !trimmed[0].Timestamp.Equal(base.Add(-10 * time.Minute)) {
		t.Errorf("trimBefore() kept wrong sample: %v", trimmed[0].Timestamp)
	}
}

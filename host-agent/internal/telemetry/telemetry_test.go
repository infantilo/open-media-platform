package telemetry

import (
	"testing"
	"time"
)

// TestTakeAgainstRealProc läuft gegen das echte /proc dieser Maschine
// (kein Mock — /proc/stat/-meminfo-Format ist Linux-Kernel-ABI, kein
// Fake-Dateisystem nötig, das Projekt läuft ohnehin nur auf Linux, s.
// UMSETZUNG.md §0 Punkt 7). Prüft nur Plausibilität, kein exakter Wert
// (Auslastung ist per Definition nicht deterministisch).
func TestTakeAgainstRealProc(t *testing.T) {
	sample, err := Take(50 * time.Millisecond)
	if err != nil {
		t.Fatalf("Take() error = %v", err)
	}
	if sample.CPUPercent < 0 || sample.CPUPercent > 100 {
		t.Errorf("CPUPercent = %v, want in [0,100]", sample.CPUPercent)
	}
	if sample.MemTotalBytes == 0 {
		t.Errorf("MemTotalBytes = 0, want > 0")
	}
	if sample.MemUsedBytes > sample.MemTotalBytes {
		t.Errorf("MemUsedBytes (%d) > MemTotalBytes (%d)", sample.MemUsedBytes, sample.MemTotalBytes)
	}
}

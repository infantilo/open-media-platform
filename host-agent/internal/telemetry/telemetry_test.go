package telemetry

import (
	"os"
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

// TestProcessSamplerAgainstOwnProcess läuft gegen den eigenen Test-
// Prozess (os.Getpid(), immer vorhanden — kein Subprozess nötig, gleiche
// Linux-/proc-ABI-Begründung wie TestTakeAgainstRealProc). Erwartet:
// erster Sample liefert kein CPU%-Delta (ok=false), zweiter (nach einem
// echten Zeitabstand) schon.
func TestProcessSamplerAgainstOwnProcess(t *testing.T) {
	s := NewProcessSampler()
	pid := os.Getpid()

	_, rss1, ok1 := s.Sample(pid)
	if ok1 {
		t.Errorf("erster Sample() ok = true, want false (kein Delta möglich)")
	}
	if rss1 == 0 {
		t.Errorf("RSS des ersten Samples = 0, want > 0")
	}

	time.Sleep(20 * time.Millisecond)
	cpu2, rss2, ok2 := s.Sample(pid)
	if !ok2 {
		t.Fatalf("zweiter Sample() ok = false, want true")
	}
	if cpu2 < 0 {
		t.Errorf("CPUPercent = %v, want >= 0", cpu2)
	}
	if rss2 == 0 {
		t.Errorf("RSS des zweiten Samples = 0, want > 0")
	}
}

// TestProcessSamplerUnknownPID prüft die Fehlerlinie: eine PID, die es
// nicht gibt (PID 1 gehört fast nie zum Testprozess, aber falls doch,
// nehmen wir eine garantiert freie sehr hohe PID) liefert ok=false statt
// eines Fehlers/Panics.
func TestProcessSamplerUnknownPID(t *testing.T) {
	s := NewProcessSampler()
	_, _, ok := s.Sample(999999)
	if ok {
		t.Errorf("Sample() für nicht existente PID ok = true, want false")
	}
}

// TestProcessSamplerPrune prüft, dass Prune() den gemerkten Zustand
// einer nicht mehr aktiven PID entfernt — ein danach erneut beobachteter
// Sample dieser (ggf. wiederverwendeten) PID liefert wieder ok=false
// (erster Sample), statt fälschlich ein Delta gegen einen veralteten
// Zustand zu bilden.
func TestProcessSamplerPrune(t *testing.T) {
	s := NewProcessSampler()
	pid := os.Getpid()
	s.Sample(pid)
	time.Sleep(5 * time.Millisecond)
	if _, _, ok := s.Sample(pid); !ok {
		t.Fatalf("zweiter Sample() vor Prune() ok = false, want true")
	}

	s.Prune(map[int]bool{})
	if _, _, ok := s.Sample(pid); ok {
		t.Errorf("Sample() direkt nach Prune() ok = true, want false (Zustand wurde entfernt)")
	}
}

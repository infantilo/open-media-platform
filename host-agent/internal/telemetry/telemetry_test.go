package telemetry

import (
	"net"
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
	sample, err := Take(50*time.Millisecond, "")
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
	if sample.Net != nil {
		t.Errorf("Net = %+v, want nil (kein Interface übergeben)", sample.Net)
	}
}

// TestTakeWithNetIfaceLoopback läuft gegen das "lo"-Interface, das auf
// jeder Linux-Maschine existiert (kein echtes 2110-Netz nötig, s.
// UMSETZUNG.md §0 Punkt 7) — erzeugt selbst etwas Loopback-Traffic, damit
// die rx/tx-Deltas nicht zufällig 0 sind (im Leerlauf plausibel, aber ein
// Test soll einen echten Zähler-Fortschritt sehen, nicht nur "kein
// Fehler").
func TestTakeWithNetIfaceLoopback(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	defer ln.Close()

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 4096)
				for {
					if _, err := conn.Read(buf); err != nil {
						return
					}
				}
			}()
		}
	}()

	payload := make([]byte, 64*1024)
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			conn, err := net.Dial("tcp", ln.Addr().String())
			if err != nil {
				return
			}
			conn.Write(payload)
			conn.Close()
			time.Sleep(2 * time.Millisecond)
		}
	}()

	sample, err := Take(80*time.Millisecond, "lo")
	if err != nil {
		t.Fatalf("Take() error = %v", err)
	}
	if sample.Net == nil {
		t.Fatalf("Net = nil, want a NetSample for iface %q", "lo")
	}
	if sample.Net.Iface != "lo" {
		t.Errorf("Net.Iface = %q, want %q", sample.Net.Iface, "lo")
	}
	if sample.Net.RxBytesPerSec <= 0 {
		t.Errorf("Net.RxBytesPerSec = %v, want > 0 (Traffic lief während der Messung)", sample.Net.RxBytesPerSec)
	}
	if sample.Net.TxBytesPerSec <= 0 {
		t.Errorf("Net.TxBytesPerSec = %v, want > 0 (Traffic lief während der Messung)", sample.Net.TxBytesPerSec)
	}
}

// TestTakeWithUnknownNetIface prüft die Nachsichts-Linie aus der Take()-
// Doku: ein nicht existentes Interface lässt die gesamte Momentaufnahme
// nicht fehlschlagen, Net bleibt einfach nil.
func TestTakeWithUnknownNetIface(t *testing.T) {
	sample, err := Take(20*time.Millisecond, "omp-does-not-exist0")
	if err != nil {
		t.Fatalf("Take() error = %v", err)
	}
	if sample.Net != nil {
		t.Errorf("Net = %+v, want nil (Interface existiert nicht)", sample.Net)
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

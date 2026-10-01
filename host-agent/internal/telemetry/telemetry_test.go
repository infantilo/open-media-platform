package telemetry

import (
	"context"
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

// TestParseNvidiaSmiOutput prüft die reine String-Verarbeitung anhand
// einer echten `nvidia-smi --format=csv,noheader,nounits`-Beispielzeile
// (Format aus der nvidia-smi-Dokumentation) — kein echtes GPU-Gerät
// nötig, s. parseNvidiaSmiOutput-Doku.
func TestParseNvidiaSmiOutput(t *testing.T) {
	sample, err := parseNvidiaSmiOutput(0, "0, 37, 2048, 8192\n")
	if err != nil {
		t.Fatalf("parseNvidiaSmiOutput() error = %v", err)
	}
	if sample.Index != 0 {
		t.Errorf("Index = %d, want 0", sample.Index)
	}
	if sample.UtilizationPercent != 37 {
		t.Errorf("UtilizationPercent = %v, want 37", sample.UtilizationPercent)
	}
	wantUsed := uint64(2048) * 1024 * 1024
	wantTotal := uint64(8192) * 1024 * 1024
	if sample.MemUsedBytes != wantUsed {
		t.Errorf("MemUsedBytes = %d, want %d", sample.MemUsedBytes, wantUsed)
	}
	if sample.MemTotalBytes != wantTotal {
		t.Errorf("MemTotalBytes = %d, want %d", sample.MemTotalBytes, wantTotal)
	}
}

// TestParseNvidiaSmiOutputMalformed prüft, dass unerwartete Ausgaben
// (z. B. eine Fehlermeldung statt CSV-Daten) einen Fehler statt eines
// stillen Null-Werts liefern.
func TestParseNvidiaSmiOutputMalformed(t *testing.T) {
	if _, err := parseNvidiaSmiOutput(0, "No devices were found\n"); err == nil {
		t.Error("parseNvidiaSmiOutput() error = nil, want an error for malformed output")
	}
}

// TestTakeGPUWithoutNvidiaSmi prüft die Nachsichts-Linie aus der
// TakeGPU-Doku gegen einen garantiert nicht existenten GPU-Index (kein
// Gerät hat Index -1) statt die Abwesenheit der nvidia-smi-Binary selbst
// anzunehmen — diese Sandbox hat zwar kein GPU-Gerät (UMSETZUNG.md §0
// Punkt 7), aber ob `nvidia-smi` überhaupt installiert ist, ist eine vom
// eigentlichen Testzweck unabhängige Umgebungseigenschaft.
func TestTakeGPUWithoutNvidiaSmi(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, ok := TakeGPU(ctx, 99999); ok {
		t.Error("TakeGPU() ok = true, want false (Index 99999 existiert nie)")
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

func TestParsePmon(t *testing.T) {
	// Format laut NVIDIA-Doku zu `nvidia-smi pmon -s um` (neuere Treiber)
	out := `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command
# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name
    0       4711     C     35      7      0      -      -      -   1024      0    omp-video-mixer
    0       4712     G     10      2      -      -      -      -    100      0    omp-viewer
    1       4712     C      5      1      -      -      -      -    300      0    omp-viewer
    0       9999     C      -      -      -      -      -      -      -      -    some thing
`
	got, err := parsePmon(out)
	if err != nil {
		t.Fatal(err)
	}
	if got[4711].SM != 35 || got[4711].FBBytes != 1024<<20 || !got[4711].HasFB {
		t.Errorf("4711 = %+v", got[4711])
	}
	// derselbe Prozess auf zwei GPUs/als C und G: Summen
	if got[4712].SM != 15 || got[4712].FBBytes != 400<<20 {
		t.Errorf("4712 = %+v", got[4712])
	}
	if got[9999].SM != 0 || got[9999].HasFB || len(got) != 3 {
		t.Errorf("9999 = %+v len=%d", got[9999], len(got))
	}
	// Älterer Treiber ohne fb-Spalte: SM ok, VRAM unbekannt
	old := "# gpu        pid  type    sm   mem   enc   dec   command\n# Idx          #   C/G     %     %     %     %   name\n    0       1  C   12   3   0   0   x\n"
	if g, err := parsePmon(old); err != nil || g[1].SM != 12 || g[1].HasFB {
		t.Errorf("old format = %v %v", g, err)
	}
	// Nur Kopfzeile = niemand nutzt die GPU → leere Map, kein Fehler
	if g, err := parsePmon("# gpu pid type sm mem\n# Idx # C/G % %\n"); err != nil || len(g) != 0 {
		t.Errorf("empty = %v %v", g, err)
	}
	// Unbekanntes Format ist ein Fehler, kein Raten
	if _, err := parsePmon("No devices were found\n"); err == nil {
		t.Error("unexpected format must fail")
	}
}

func TestGPUForTree(t *testing.T) {
	parents := map[int]int{200: 100, 300: 200, 400: 1, 500: 400}
	procs := map[int]GPUProc{100: {SM: 10, FBBytes: 100, HasFB: true}, 300: {SM: 20, FBBytes: 50, HasFB: true}, 500: {SM: 99}}
	g := GPUForTree(procs, parents, 100)
	if g.SM != 30 || g.FBBytes != 150 || !g.HasFB {
		t.Errorf("tree(100) = %+v", g)
	}
	if g := GPUForTree(procs, parents, 7); g.SM != 0 || g.HasFB {
		t.Errorf("tree(unrelated) = %+v", g)
	}
}

func TestParseNvidiaSmiPool(t *testing.T) {
	s, err := parseNvidiaSmiOutput(-1, "0, 40, 1000, 8000\n1, 20, 3000, 8000\n")
	if err != nil {
		t.Fatal(err)
	}
	// Pool: Auslastung gemittelt, Speicher summiert
	if s.Count != 2 || s.UtilizationPercent != 30 || s.MemUsedBytes != 4000<<20 || s.MemTotalBytes != 16000<<20 || s.Index != -1 {
		t.Errorf("pool = %+v", s)
	}
}

func TestParseGPUSpec(t *testing.T) {
	cases := []struct {
		in      string
		idx     int
		enabled bool
		bad     bool
	}{
		{"", -1, true, false}, {"auto", -1, true, false}, {"AUTO", -1, true, false},
		{"off", -1, false, false}, {"none", -1, false, false},
		{"0", 0, true, false}, {"2", 2, true, false},
		{"-1", -1, false, true}, {"x", -1, false, true},
	}
	for _, c := range cases {
		idx, en, err := ParseGPUSpec(c.in)
		if (err != nil) != c.bad || (!c.bad && (idx != c.idx || en != c.enabled)) {
			t.Errorf("ParseGPUSpec(%q) = %d,%v,%v", c.in, idx, en, err)
		}
	}
}

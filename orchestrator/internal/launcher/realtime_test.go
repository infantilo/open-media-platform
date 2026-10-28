package launcher

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWrapRealtime(t *testing.T) {
	cmd := []string{"/bin/node", "--x"}
	if got := wrapRealtime("t", nil, cmd); !reflect.DeepEqual(got, cmd) {
		t.Fatalf("nil: %v", got)
	}
	got := wrapRealtime("t", &CatalogRealtime{Cpus: "0"}, cmd)
	want := []string{"taskset", "-c", "0", "/bin/node", "--x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for _, bad := range []string{"a-b", "0,,1", "99999"} {
		if got := wrapRealtime("t", &CatalogRealtime{Cpus: bad}, cmd); !reflect.DeepEqual(got, cmd) {
			t.Fatalf("%q nicht ignoriert: %v", bad, got)
		}
	}
	t.Setenv("OMP_RT_DISABLE", "1")
	if got := wrapRealtime("t", &CatalogRealtime{Cpus: "0"}, cmd); !reflect.DeepEqual(got, cmd) {
		t.Fatalf("disable: %v", got)
	}
}

// Startet über den echten execEntry-Pfad einen Prozess mit realtime-Eintrag und
// prüft Affinität/Nice in /proc des laufenden Prozesses.
func TestExecEntryRealtimeApplied(t *testing.T) {
	l := &Launcher{}
	entry := CatalogEntry{Type: "rt-test", Command: []string{"sleep", "10"}, Realtime: &CatalogRealtime{Cpus: "0", Nice: 5}}
	cmd, _, err := l.execEntry(entry, "rt1", "rt1", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()
	var status, stat string
	for i := 0; i < 50; i++ { // exec der Wrapper-Kette abwarten
		time.Sleep(20 * time.Millisecond)
		b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/comm", cmd.Process.Pid))
		if strings.TrimSpace(string(b)) == "sleep" {
			break
		}
	}
	b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/status", cmd.Process.Pid))
	status = string(b)
	b, _ = os.ReadFile(fmt.Sprintf("/proc/%d/stat", cmd.Process.Pid))
	stat = string(b)
	if !strings.Contains(status, "Cpus_allowed_list:\t0\n") {
		t.Fatalf("Affinität nicht gesetzt:\n%s", status)
	}
	f := strings.Fields(stat[strings.LastIndex(stat, ")")+2:])
	// nice wirkt relativ zum Elternprozess (nice -n 5).
	pb, _ := os.ReadFile("/proc/self/stat")
	pf := strings.Fields(string(pb)[strings.LastIndex(string(pb), ")")+2:])
	pn, _ := strconv.Atoi(pf[16])
	if f[16] != strconv.Itoa(pn+5) { // nice = Feld 19, nach ")" Index 16
		t.Fatalf("nice=%s, erwartet %d", f[16], pn+5)
	}
}

func TestWithCPUAffinityOverlaysCatalogAndIsOffByDefault(t *testing.T) {
	if got := withCPUAffinity(nil, nil); got != nil {
		t.Fatalf("ohne Option und ohne Katalogwert keine Bindung: %+v", got)
	}
	cat := &CatalogRealtime{Cpus: "0-1", Policy: "fifo", Priority: 10}
	if got := withCPUAffinity(cat, map[string]string{"OMP_CPU_AFFINITY": "  "}); got != cat {
		t.Fatal("leere Option lässt den Katalogwert unberührt")
	}
	got := withCPUAffinity(cat, map[string]string{"OMP_CPU_AFFINITY": " 2-3 "})
	if got == cat || got.Cpus != "2-3" || got.Policy != "fifo" || got.Priority != 10 || cat.Cpus != "0-1" {
		t.Fatalf("Option überlagert nur die CPU-Liste, Katalog bleibt unverändert: %+v / %+v", got, cat)
	}
	if got := withCPUAffinity(nil, map[string]string{"OMP_CPU_AFFINITY": "0"}); got == nil || got.Cpus != "0" {
		t.Fatalf("Option allein genügt: %+v", got)
	}
}

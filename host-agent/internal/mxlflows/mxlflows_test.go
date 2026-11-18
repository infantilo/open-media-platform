package mxlflows

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func mkFlow(t *testing.T, domain, id, def string) string {
	t.Helper()
	dir := filepath.Join(domain, id+".mxl-flow")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "flow_def.json"), []byte(def), 0o644); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(dir, "data")
	if err := os.WriteFile(data, make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	return data
}

func devMajorMinor(dev uint64) (uint32, uint32) {
	major := uint32(((dev >> 32) & 0xfffff000) | ((dev >> 8) & 0x00000fff))
	minor := uint32(((dev >> 12) & 0xffffff00) | (dev & 0x000000ff))
	return major, minor
}

func TestMakedevRoundTrip(t *testing.T) {
	for _, c := range [][2]uint32{{0, 25}, {8, 1}, {259, 70000 % 0x100000}, {0xfff, 0xfffff}} {
		maj, min := devMajorMinor(makedev(c[0], c[1]))
		if maj != c[0] || min != c[1] {
			t.Fatalf("%v -> %d:%d", c, maj, min)
		}
	}
}

func TestScanWriterAndStale(t *testing.T) {
	domain := t.TempDir()
	active := mkFlow(t, domain, "11111111-1111-1111-1111-111111111111",
		`{"label":"Kamera 1","format":"urn:x-nmos:format:video"}`)
	mkFlow(t, domain, "22222222-2222-2222-2222-222222222222", `{"label":"Rest","format":"urn:x-nmos:format:audio"}`)
	if err := os.MkdirAll(filepath.Join(domain, "kein-flow"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Wie ein MXL-Schreiber: geteiltes flock auf `data` halten.
	fd, err := os.Open(active)
	if err != nil {
		t.Fatal(err)
	}
	defer fd.Close()
	if err := syscall.Flock(int(fd.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}

	var st syscall.Stat_t
	if err := syscall.Stat(active, &st); err != nil {
		t.Fatal(err)
	}
	maj, min := devMajorMinor(uint64(st.Dev))
	proc := t.TempDir()
	locks := fmt.Sprintf("1: FLOCK  ADVISORY  READ %d %02x:%02x:%d 0 EOF\n"+
		"2: FLOCK  ADVISORY  WRITE 999 00:01:5 0 EOF\n"+
		"2: POSIX  ADVISORY  WRITE 7 %02x:%02x:%d 0 EOF\n"+
		"3: -> FLOCK  ADVISORY  WRITE 8 %02x:%02x:%d 0 EOF\n",
		os.Getpid(), maj, min, st.Ino, maj, min, st.Ino, maj, min, st.Ino)
	if err := os.WriteFile(filepath.Join(proc, "locks"), []byte(locks), 0o644); err != nil {
		t.Fatal(err)
	}
	pd := filepath.Join(proc, fmt.Sprint(os.Getpid()))
	if err := os.MkdirAll(pd, 0o755); err != nil {
		t.Fatal(err)
	}
	id64 := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	_ = os.WriteFile(filepath.Join(pd, "comm"), []byte("omp-source\n"), 0o644)
	_ = os.WriteFile(filepath.Join(pd, "cgroup"), []byte("0::/user.slice/libpod-"+id64+".scope/container\n"), 0o644)

	flows, err := Scan(domain, Options{ProcRoot: proc})
	if err != nil {
		t.Fatal(err)
	}
	if len(flows) != 2 {
		t.Fatalf("flows = %+v", flows)
	}
	var a, s Flow
	for _, f := range flows {
		if f.Label == "Kamera 1" {
			a = f
		} else {
			s = f
		}
	}
	if !a.Active || a.Stale || len(a.Writers) != 1 || a.Writers[0].PID != os.Getpid() ||
		a.Writers[0].Cmd != "omp-source" || a.Writers[0].Container != id64[:12] || a.Format != "urn:x-nmos:format:video" {
		t.Fatalf("aktiver Flow falsch: %+v", a)
	}
	if s.Active || !s.Stale || len(s.Writers) != 0 || s.SizeBytes < 4096 {
		t.Fatalf("Rest-Flow falsch: %+v", s)
	}
}

func TestScanMissingDomainIsEmpty(t *testing.T) {
	flows, err := Scan(filepath.Join(t.TempDir(), "nope"), Options{})
	if err != nil || flows == nil || len(flows) != 0 {
		t.Fatalf("%v %v", flows, err)
	}
}

func TestContainerFromCgroup(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cases := map[string]string{
		"0::/system.slice/docker-" + id + ".scope\n":       id[:12],
		"12:cpu:/docker/" + id + "\n":                      id[:12],
		"0::/user.slice/user-1000.slice/session-1.scope\n": "",
	}
	for in, want := range cases {
		if got := containerFromCgroup(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
}

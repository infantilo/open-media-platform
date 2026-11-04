package podmanrun

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewriteForContainer(t *testing.T) {
	if got := RewriteForContainer("http://127.0.0.1:8010/x"); got != "http://host.containers.internal:8010/x" {
		t.Fatal(got)
	}
	if got := RewriteForContainer("nats://10.0.0.5:4222"); got != "nats://10.0.0.5:4222" {
		t.Fatal(got)
	}
}

func TestBuildArgsDefaultAndOptIns(t *testing.T) {
	e := Entry{Type: "t", Image: "img:1", Command: []string{"run", "--x"}, Env: map[string]string{"A": "1"}}
	p := Params{ID: "i1", Label: "L", RegistryURL: "http://127.0.0.1:8010", NatsURL: "nats://127.0.0.1:4222", OrchestratorURL: "http://127.0.0.1:8000", LaunchSecret: "s"}
	a := strings.Join(BuildArgs(e, p, 5555, 0), " ")
	for _, want := range []string{"run -d --rm --name omp-i1", "-p 5555:5555", "OMP_HOST=127.0.0.1", "OMP_PORT=5555", "OMP_REGISTRY_URL=http://host.containers.internal:8010", "OMP_LAUNCH_SECRET=s", "A=1", "img:1 run --x"} {
		if !strings.Contains(a, want) {
			t.Errorf("fehlt %q in %s", want, a)
		}
	}
	for _, not := range []string{"--network=host", "-v "} {
		if strings.Contains(a, not) {
			t.Errorf("unerwartet %q in %s", not, a)
		}
	}
	e.HostNetwork, e.MxlAccess, e.DataDir, e.ExtraPort = true, true, "/data", true
	p.AdvertiseHost = "10.1.2.3"
	a = strings.Join(BuildArgs(e, p, 5555, 6666), " ")
	for _, want := range []string{"--network=host", "omp-data-t:/data", "OMP_HOST=10.1.2.3", "OMP_EXTRA_PORT=6666", "OMP_REGISTRY_URL=http://127.0.0.1:8010"} {
		if !strings.Contains(a, want) {
			t.Errorf("fehlt %q in %s", want, a)
		}
	}
	if strings.Contains(a, "-p 5555") {
		t.Errorf("Host-Netz darf keine Port-Veröffentlichung haben: %s", a)
	}
}

// fakePodman schreibt ein Skript, das seine Argumente protokolliert.
func fakePodman(t *testing.T, stdout string, exit int) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "log")
	script := "#!/bin/sh\necho \"$@\" >> " + log + "\nprintf '%s' '" + stdout + "'\nexit " + string(rune('0'+exit)) + "\n"
	bin := filepath.Join(dir, "podman")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := Binary
	Binary = bin
	t.Cleanup(func() { Binary = old })
	return log
}

func TestRunStopWaitRunning(t *testing.T) {
	log := fakePodman(t, "cid123", 0)
	id, port, err := Run(Entry{Type: "t", Image: "img"}, Params{ID: "x"})
	if err != nil || id != "cid123" || port == 0 {
		t.Fatalf("Run: %q %d %v", id, port, err)
	}
	if err := Stop("cid123", 0); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "stop --time 1 cid123") {
		t.Fatalf("log: %s", b)
	}
}

func TestRunError(t *testing.T) {
	fakePodman(t, "", 1)
	if _, _, err := Run(Entry{Type: "t", Image: "img"}, Params{ID: "x"}); err == nil {
		t.Fatal("Fehler erwartet")
	}
}

package podmanrun

import (
	"os"
	"path/filepath"
	"regexp"
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

func TestDomainPathAndBuildArgs(t *testing.T) {
	t.Setenv("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl")
	for name, want := range map[string]string{"test": "/dev/shm/omp-mxl-test", "studio-2": "/dev/shm/omp-mxl-studio-2"} {
		if got, ok := DomainPath(name); !ok || got != want {
			t.Errorf("DomainPath(%q) = %q, %v", name, got, ok)
		}
	}
	for _, bad := range []string{"", "default", "Test", "1a", "a--b", "../x", "a/b", "a-"} {
		if _, ok := DomainPath(bad); ok {
			t.Errorf("%q muss abgelehnt werden", bad)
		}
	}
	e := Entry{Type: "box", Image: "img", MxlAccess: true}
	args := strings.Join(BuildArgs(e, Params{ID: "i1", ExtraEnv: map[string]string{DomainNameKey: "test"}}, 1234, 0), " ")
	if !strings.Contains(args, "-v /dev/shm/omp-mxl-test:/dev/shm/omp-mxl-test") || !strings.Contains(args, "OMP_MXL_DOMAIN=/dev/shm/omp-mxl-test") {
		t.Errorf("Domain nicht eingehängt: %s", args)
	}
	if strings.Contains(args, DomainNameKey) {
		t.Errorf("der Name darf nicht in die Container-Umgebung: %s", args)
	}
	plain := strings.Join(BuildArgs(e, Params{ID: "i1"}, 1234, 0), " ")
	if !strings.Contains(plain, "-v /dev/shm/omp-mxl:/dev/shm/omp-mxl") || strings.Contains(plain, "omp-mxl-") {
		t.Errorf("Standard unverändert: %s", plain)
	}
}

func TestDomainID(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	a, b := DomainID("default"), DomainID("studio")
	if !re.MatchString(a) || !re.MatchString(b) {
		t.Fatalf("keine gültige BCP-007-03-UUID: %s %s", a, b)
	}
	if a == b || a != DomainID("default") {
		t.Errorf("IDs müssen stabil und je Domain verschieden sein: %s %s", a, b)
	}
	if a[14] != '5' {
		t.Errorf("Version 5 erwartet: %s", a)
	}
	m := map[string]string{DomainNameKey: "studio", TargetDomainNameKey: "test"}
	ApplyDomainEnv(m)
	if m["OMP_MXL_DOMAIN_ID"] != b || m["OMP_MXL_TARGET_DOMAIN_ID"] != DomainID("test") {
		t.Errorf("IDs fehlen: %v", m)
	}
	d := map[string]string{}
	ApplyDomainEnv(d)
	if d["OMP_MXL_DOMAIN_ID"] != a {
		t.Errorf("Standarddomain bekommt ihre ID: %v", d)
	}
}

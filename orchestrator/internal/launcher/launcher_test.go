package launcher

import (
	"os"
	"strings"
	"testing"
	"time"
)

// sleepyCatalog startet einen echten, kurzlebigen Subprozess, der lang
// genug lebt, um in Tests beobachtet zu werden — os/exec lässt sich
// nicht sinnvoll ohne echten Subprozess testen (kein Interface-Seam im
// Standardpaket). `sleep` direkt (kein Shell-Wrapper): terminiert per
// Default-Disposition sofort auf SIGTERM, kein Risiko verwaister
// Hintergrund-Kindprozesse wie bei einem "cmd & wait"-Shell-Muster.
func sleepyCatalog() []CatalogEntry {
	return []CatalogEntry{{
		Type:    "sleepy",
		Label:   "Sleepy",
		Runner:  "process",
		Command: []string{"sleep", "30"},
		Env:     map[string]string{},
	}}
}

// stubbornCatalog ignoriert SIGTERM, damit der SIGKILL-Fallback in
// Stop() getestet werden kann. `trap '' TERM` setzt die Disposition auf
// SIG_IGN, die laut POSIX über `exec` hinweg erhalten bleibt — `exec
// sleep 30` ersetzt den Shell-Prozess durch `sleep` selbst (gleiche PID,
// kein separater Hintergrund-Kindprozess).
func stubbornCatalog() []CatalogEntry {
	return []CatalogEntry{{
		Type:    "stubborn",
		Label:   "Stubborn",
		Runner:  "process",
		Command: []string{"/bin/sh", "-c", "trap '' TERM; exec sleep 30"},
		Env:     map[string]string{},
	}}
}

func TestLauncherStartUnknownTypeReturnsError(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir())

	if _, err := l.Start("does-not-exist"); err != ErrUnknownType {
		t.Fatalf("Start() error = %v, want ErrUnknownType", err)
	}
}

func TestLauncherStartUnsupportedRunnerReturnsError(t *testing.T) {
	catalog := []CatalogEntry{{Type: "x", Label: "X", Runner: "podman", Command: []string{"true"}}}
	l := New(catalog, "http://registry", "nats://nats", t.TempDir())

	if _, err := l.Start("x"); err != ErrUnsupportedRunner {
		t.Fatalf("Start() error = %v, want ErrUnsupportedRunner", err)
	}
}

func TestLauncherStartAppearsInListAndStopRemovesIt(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir())

	inst, err := l.Start("sleepy")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if inst.Type != "sleepy" || inst.PID <= 0 {
		t.Fatalf("Start() = %+v, want valid type/pid", inst)
	}
	if !processAlive(inst.PID) {
		t.Fatal("started process is not alive")
	}

	list := l.List()
	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry with id %s", list, inst.ID)
	}

	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if processAlive(inst.PID) {
		t.Error("process still alive after Stop()")
	}
	if len(l.List()) != 0 {
		t.Errorf("List() after Stop() = %+v, want empty", l.List())
	}
}

func TestLauncherStopSendsSigkillIfSigtermIgnored(t *testing.T) {
	original := stopGracePeriod
	stopGracePeriod = 500 * time.Millisecond
	defer func() { stopGracePeriod = original }()

	l := New(stubbornCatalog(), "http://registry", "nats://nats", t.TempDir())
	inst, err := l.Start("stubborn")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if processAlive(inst.PID) {
		t.Error("process still alive after Stop() should have escalated to SIGKILL")
	}
}

func TestLauncherStopUnknownInstanceReturnsError(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir())
	if err := l.Stop("does-not-exist"); err != ErrUnknownInstance {
		t.Fatalf("Stop() error = %v, want ErrUnknownInstance", err)
	}
}

func TestLauncherReloadsStillRunningInstanceAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	l1 := New(sleepyCatalog(), "http://registry", "nats://nats", dataDir)
	inst, err := l1.Start("sleepy")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() { _ = l1.Stop(inst.ID) }()

	l2 := New(sleepyCatalog(), "http://registry", "nats://nats", dataDir)
	list := l2.List()
	if len(list) != 1 || list[0].ID != inst.ID || list[0].PID != inst.PID {
		t.Fatalf("List() after restart = %+v, want the still-running instance %+v", list, inst)
	}
}

func TestLauncherDropsDeadInstanceAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	quickExit := []CatalogEntry{{Type: "quick", Label: "Quick", Runner: "process", Command: []string{"/bin/sh", "-c", "exit 0"}}}

	l1 := New(quickExit, "http://registry", "nats://nats", dataDir)
	inst, err := l1.Start("quick")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for processAlive(inst.PID) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(inst.PID) {
		t.Fatal("quick-exit process did not terminate in time")
	}

	l2 := New(quickExit, "http://registry", "nats://nats", dataDir)
	if list := l2.List(); len(list) != 0 {
		t.Errorf("List() after restart = %+v, want empty (dead instance dropped)", list)
	}
}

func TestLauncherStartSetsRequiredEnvVars(t *testing.T) {
	envFile := t.TempDir() + "/env.txt"
	catalog := []CatalogEntry{{
		Type:   "envdump",
		Label:  "EnvDump",
		Runner: "process",
		Command: []string{
			"/bin/sh", "-c",
			"env > " + envFile,
		},
		Env: map[string]string{"OMP_CUSTOM": "from-catalog"},
	}}
	l := New(catalog, "http://registry:8010", "nats://nats:4222", t.TempDir())

	inst, err := l.Start("envdump")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	var data []byte
	for time.Now().Before(deadline) {
		data, err = os.ReadFile(envFile)
		if err == nil && len(data) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("read env dump: %v", err)
	}

	env := string(data)
	checks := map[string]string{
		"OMP_INSTANCE_ID":  inst.ID,
		"OMP_LABEL":        inst.Label,
		"OMP_PORT":         "0",
		"OMP_REGISTRY_URL": "http://registry:8010",
		"OMP_NATS_URL":     "nats://nats:4222",
		"OMP_CUSTOM":       "from-catalog",
	}
	for key, want := range checks {
		if !strings.Contains(env, key+"="+want) {
			t.Errorf("subprocess env missing %s=%s;\nfull env:\n%s", key, want, env)
		}
	}
}

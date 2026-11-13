package launcher

import (
	"encoding/json"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

func fastAdoption(t *testing.T) {
	t.Helper()
	poll, backoff := adoptPollInterval, crashRestartBackoff
	adoptPollInterval, crashRestartBackoff = 20*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { adoptPollInterval, crashRestartBackoff = poll, backoff })
}

// startForeignProcess startet einen Prozess, der (wie nach einem Orchestrator-Neustart) kein Kind des Launchers ist.
func startForeignProcess(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

// TestAdoptedLocalInstanceIsSupervised — nach einem Orchestrator-Neustart läuft die Instanz weiter (per PID
// wiedererkannt). Stürzt sie danach ab, muss das wie bei einem selbst gestarteten Kindprozess erkannt und die Instanz
// unter derselben ID neu gestartet werden.
func TestAdoptedLocalInstanceIsSupervised(t *testing.T) {
	fastAdoption(t)
	proc := startForeignProcess(t)
	oldPID := proc.Process.Pid
	store := newFakeInstanceStore()
	_ = store.Put(Instance{ID: "adopted-1", Type: "sleepy", Label: "Quelle", PID: oldPID, Origin: "http://me:8000"})

	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", store, nil, nil, nil)
	l.SetOrchestratorURL("http://me:8000")
	l.RestoreLocal()
	defer func() { _ = l.Stop("adopted-1") }()

	if in, ok := l.Get("adopted-1"); !ok || in.PID != oldPID {
		t.Fatalf("adopted instance = %+v (found=%v), want it tracked with pid %d", in, ok, oldPID)
	}

	_ = proc.Process.Kill()
	_ = proc.Wait() // reapen, sonst bleibt ein Zombie, den Signal 0 noch als lebend meldet

	deadline := time.Now().Add(3 * time.Second)
	var in Instance
	for time.Now().Before(deadline) {
		in, _ = l.Get("adopted-1")
		if in.PID != oldPID && in.PID != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if in.PID == oldPID || !processAlive(in.PID) || in.Crashed || in.RestartCount != 1 {
		t.Fatalf("adopted instance after crash = %+v, want restarted once under a new pid", in)
	}
}

// TestAdoptedForeignOriginInstanceIsNotSupervised — mehrere Orchestratoren auf einem Rechner erkennen dieselbe PID
// wieder; neu starten darf sie nur ihr Starter, sonst liefe die Instanz nach einem Absturz mehrfach.
func TestAdoptedForeignOriginInstanceIsNotSupervised(t *testing.T) {
	fastAdoption(t)
	proc := startForeignProcess(t)
	oldPID := proc.Process.Pid
	store := newFakeInstanceStore()
	_ = store.Put(Instance{ID: "foreign-1", Type: "sleepy", PID: oldPID, Origin: "http://other:8000"})

	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", store, nil, nil, nil)
	l.SetOrchestratorURL("http://me:8000")
	l.RestoreLocal()

	_ = proc.Process.Kill()
	_ = proc.Wait()
	time.Sleep(200 * time.Millisecond)

	if in, _ := l.Get("foreign-1"); in.PID != oldPID || in.RestartCount != 0 {
		t.Fatalf("foreign-origin instance = %+v, want untouched (pid %d, no restart)", in, oldPID)
	}
}

// TestLoadStateKeepsDeadRowsOfClusterPartner — die Instanz-Tabelle ist im Cluster geteilt. Eine abgestürzte lokale
// Instanz eines Partners (auf dessen Rechner) darf beim eigenen Start nicht aus der Tabelle gelöscht werden.
func TestLoadStateKeepsDeadRowsOfClusterPartner(t *testing.T) {
	store := newFakeInstanceStore()
	_ = store.Put(Instance{ID: "other-crashed", Type: "sleepy", PID: 999999997, Crashed: true, Origin: "http://other:8000"})
	_ = store.Put(Instance{ID: "mine-crashed", Type: "sleepy", PID: 999999996, Crashed: true, Origin: "http://me:8000"})
	_ = store.Put(Instance{ID: "legacy-crashed", Type: "sleepy", PID: 999999995, Crashed: true})

	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", store, nil, nil, nil)
	l.SetOrchestratorURL("http://me:8000")
	l.RestoreLocal()

	if _, ok := store.data["other-crashed"]; !ok {
		t.Errorf("row of the cluster partner was deleted")
	}
	if _, ok := store.data["mine-crashed"]; ok {
		t.Errorf("own dead crashed row must be dropped")
	}
	if _, ok := store.data["legacy-crashed"]; ok {
		t.Errorf("dead crashed row without origin must be dropped as before")
	}
}

type countingRequester struct{ calls atomic.Int32 }

func (c *countingRequester) RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	c.calls.Add(1)
	return json.Marshal(remoteResponse{OK: true, PID: 4242})
}

// TestRestoreRemoteSkipsInstanceRemovedMeanwhile — die Vormerkung entsteht beim Start des Orchestrators, die Führung
// (und damit RestoreRemote) kann viel später kommen. Eine inzwischen von einem anderen Mitglied gestoppte Instanz
// (Zeile gelöscht) darf nicht wieder gestartet werden.
func TestRestoreRemoteSkipsInstanceRemovedMeanwhile(t *testing.T) {
	store := newFakeInstanceStore()
	_ = store.Put(Instance{ID: "gone-1", Type: "omp-source", HostID: "host-1", PID: 999999994})
	_ = store.Put(Instance{ID: "kept-1", Type: "omp-source", HostID: "host-1", PID: 999999993})
	nc := &countingRequester{}

	l := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)
	l.RestoreLocal()
	_ = store.Delete("gone-1") // ein anderes Cluster-Mitglied hat die Instanz gestoppt
	l.RestoreRemote()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if in, ok := l.Get("kept-1"); ok && in.PID == 4242 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if in, ok := l.Get("kept-1"); !ok || in.PID != 4242 {
		t.Fatalf("still persisted remote instance not restored: %+v (found=%v)", in, ok)
	}
	if _, ok := l.Get("gone-1"); ok {
		t.Errorf("removed instance was resurrected")
	}
	if n := nc.calls.Load(); n != 1 {
		t.Errorf("remote commands sent = %d, want 1 (only for the still persisted instance)", n)
	}
	if _, ok := store.data["gone-1"]; ok {
		t.Errorf("removed instance row reappeared in the store")
	}
}

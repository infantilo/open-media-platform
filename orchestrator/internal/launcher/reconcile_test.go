package launcher

import (
	"testing"
	"time"
)

// TestReconcileRemoteRestartsInstanceMissingAtAgent — nach einem Neustart des Host-Agents (oder des Hosts) gibt es
// kein Exit-Ereignis. Fehlt eine als laufend geführte Instanz mehrfach in Folge in der Meldung des Agents, wird sie
// unter derselben ID neu gestartet; eine einzelne Lücke oder eine gemeldete Instanz löst nichts aus.
func TestReconcileRemoteRestartsInstanceMissingAtAgent(t *testing.T) {
	backoff := crashRestartBackoff
	crashRestartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { crashRestartBackoff = backoff })

	nc := &countingRequester{}
	l := newWithStore(nil, "http://registry", "nats://nats", newFakeInstanceStore(), nil, nc, nil)
	a, err := l.Start("omp-source", "", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	b, err := l.Start("omp-source", "", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	other, err := l.Start("omp-source", "", "host-2", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	sent := nc.calls.Load()

	// Eine Lücke, dann wieder da: Zähler zurückgesetzt.
	l.ReconcileRemote("host-1", []string{b.ID})
	l.ReconcileRemote("host-1", []string{a.ID, b.ID})
	for i := 0; i < remoteMissingThreshold-1; i++ {
		if lost := l.ReconcileRemote("host-1", []string{b.ID}); len(lost) != 0 {
			t.Fatalf("restart triggered after %d missing reports, want %d", i+1, remoteMissingThreshold)
		}
	}
	lost := l.ReconcileRemote("host-1", []string{b.ID})
	if len(lost) != 1 || lost[0] != a.ID {
		t.Fatalf("ReconcileRemote lost = %v, want [%s]", lost, a.ID)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if in, _ := l.Get(a.ID); in.RestartCount == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if in, ok := l.Get(a.ID); !ok || in.RestartCount != 1 || in.Crashed {
		t.Fatalf("missing instance after reconcile = %+v (found=%v), want restarted once", in, ok)
	}
	if n := nc.calls.Load(); n != sent+1 {
		t.Errorf("remote commands after reconcile = %d, want exactly one start (%d)", n, sent+1)
	}
	if in, _ := l.Get(b.ID); in.RestartCount != 0 {
		t.Errorf("reported instance was restarted: %+v", in)
	}
	if in, _ := l.Get(other.ID); in.RestartCount != 0 {
		t.Errorf("instance on another host was touched: %+v", in)
	}
}

// TestReconcileRemoteSkipsCrashedAndBusy — aufgegebene (abgestürzte) Instanzen und solche, deren Start gerade läuft,
// werden nicht gezählt.
func TestReconcileRemoteSkipsCrashedAndBusy(t *testing.T) {
	nc := &countingRequester{}
	l := newWithStore(nil, "http://registry", "nats://nats", newFakeInstanceStore(), nil, nc, nil)
	crashed, _ := l.Start("omp-source", "", "host-1", nil)
	busy, _ := l.Start("omp-source", "", "host-1", nil)
	l.mu.Lock()
	c := l.instances[crashed.ID]
	c.Crashed = true
	l.instances[crashed.ID] = c
	l.mu.Unlock()
	l.setRemoteBusy(busy.ID, true)

	for i := 0; i < remoteMissingThreshold+2; i++ {
		if lost := l.ReconcileRemote("host-1", []string{}); len(lost) != 0 {
			t.Fatalf("ReconcileRemote lost = %v, want none", lost)
		}
	}
}

package workflows

import (
	"context"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// setupMigrationWorkflow startet einen Workflow mit zwei Rollen ("src",
// omp-source, ohne besondere Placement-Policy; "active", omp-viewer, mit
// der übergebenen escalation/windowSeconds) und genau einer Connection
// src->active — knapp genug, um sowohl den Make-before-break-Ablauf
// (neue Instanz, State-Capture, Reconnect, Teardown der alten) als auch
// die Eskalationsstufen-Verzweigung selbst zu prüfen.
func setupMigrationWorkflow(t *testing.T, escalation string, windowSeconds int) (svc *Service, nodes *fakeNodeLister, g *fakeGraph, l *fakeLauncher, wfID, activeInstance string) {
	t.Helper()
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { registrationTimeout, registrationPollInterval = original, originalPoll })

	nodes = &fakeNodeLister{}
	g = &fakeGraph{}
	l = &fakeLauncher{}
	svc = newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"},
			{Name: "active", NodeType: "omp-viewer", Placement: &RolePlacementPolicy{Escalation: escalation, ConfirmWindowSeconds: windowSeconds}},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "active"}},
	}
	created, err := svc.Create("regie", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), created.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 2
	})

	srcInstance := l.instanceIDFor("omp-source")
	activeInstance = l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-src"}}})
	nodes.add(registry.NodeView{ID: "node-active", InstanceID: activeInstance, Receivers: []registry.ReceiverView{{ID: "recv-active"}}})
	waitForStatus(t, svc, created.ID, StatusStarted)

	return svc, nodes, g, l, created.ID, activeInstance
}

// waitFor pollt cond bis zu 2s, fatal bei Timeout — gleiches
// Poll-Timeout-Muster wie die übrigen Tests dieses Pakets
// (registrationTimeout-Größenordnung).
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within timeout")
}

func TestOnAdviceRaisedAdvisoryDoesNothing(t *testing.T) {
	svc, _, _, l, _, activeInstance := setupMigrationWorkflow(t, "", 0)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})

	// Advisory löst nichts aus — kurz warten und sicherstellen, dass
	// KEIN zusätzlicher Start passiert (Negativ-Test, daher fixe kurze
	// Wartezeit statt waitFor).
	time.Sleep(100 * time.Millisecond)
	l.mu.Lock()
	started := len(l.started)
	l.mu.Unlock()
	if started != 2 {
		t.Fatalf("started = %d, want 2 (advisory must not trigger a migration)", started)
	}
}

func TestExecuteMigrationAutoEscalationHappyPath(t *testing.T) {
	svc, nodes, g, l, wfID, activeInstance := setupMigrationWorkflow(t, EscalationAuto, 0)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	if newInstance == activeInstance {
		t.Fatalf("expected a fresh instance ID for the migrated role")
	}
	nodes.add(registry.NodeView{ID: "node-active-2", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active-2"}}})

	waitFor(t, func() bool {
		wf, err := svc.Get(wfID)
		if err != nil {
			return false
		}
		return wf.Runtime["active"].InstanceID == newInstance
	})

	wf, err := svc.Get(wfID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if wf.Runtime["active"].HostID != "host-b" {
		t.Fatalf("Runtime HostID = %q, want %q", wf.Runtime["active"].HostID, "host-b")
	}

	// Make-before-break: die alte Instanz muss erst NACH dem
	// erfolgreichen Cutover gestoppt werden — hier (nach dem Cutover
	// oben) muss sie in l.stopped stehen.
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, id := range l.stopped {
			if id == activeInstance {
				return true
			}
		}
		return false
	})

	// Reconnect: die Connection src->active muss gegen den neuen
	// Receiver ("recv-active-2") erneut angewendet worden sein.
	waitFor(t, func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, c := range g.calls {
			if c.toReceiver == "recv-active-2" {
				return true
			}
		}
		return false
	})
}

func TestAutoConfirmWindowExpiresAndMigrates(t *testing.T) {
	svc, nodes, _, l, wfID, activeInstance := setupMigrationWorkflow(t, EscalationAutoConfirmWindow, 1)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})

	// considerMigration läuft in einer eigenen Goroutine (s.
	// OnAdviceRaised-Doku) — auf das Erscheinen des Pending-Eintrags
	// warten statt ihn synchron sofort zu erwarten.
	waitFor(t, func() bool { return len(svc.PendingMigrations()) == 1 })
	pending := svc.PendingMigrations()
	if len(pending) != 1 || pending[0].WorkflowID != wfID || pending[0].Role != "active" || pending[0].TargetHostID != "host-b" {
		t.Fatalf("PendingMigrations() = %+v, want one pending entry for (wf=%s, role=active, target=host-b)", pending, wfID)
	}

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-active-2", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active-2"}}})

	waitFor(t, func() bool {
		wf, err := svc.Get(wfID)
		if err != nil {
			return false
		}
		return wf.Runtime["active"].InstanceID == newInstance
	})
	if got := svc.PendingMigrations(); len(got) != 0 {
		t.Fatalf("PendingMigrations() after expiry = %+v, want empty", got)
	}
}

func TestConfirmMigrationExecutesImmediately(t *testing.T) {
	svc, nodes, _, l, wfID, activeInstance := setupMigrationWorkflow(t, EscalationAutoConfirmWindow, 30)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})
	waitFor(t, func() bool { return len(svc.PendingMigrations()) == 1 })

	if err := svc.ConfirmMigration(wfID, "active"); err != nil {
		t.Fatalf("ConfirmMigration() error = %v", err)
	}
	if got := svc.PendingMigrations(); len(got) != 0 {
		t.Fatalf("PendingMigrations() right after confirm = %+v, want empty (removed synchronously)", got)
	}

	// Ausführung selbst läuft asynchron (wie Start/Stop) — muss trotz
	// des 30s-Fensters zeitnah passieren, nicht erst nach Ablauf.
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-active-2", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active-2"}}})
	waitFor(t, func() bool {
		wf, err := svc.Get(wfID)
		if err != nil {
			return false
		}
		return wf.Runtime["active"].InstanceID == newInstance
	})
}

func TestCancelMigrationLeavesOldInstanceRunning(t *testing.T) {
	svc, _, _, l, wfID, activeInstance := setupMigrationWorkflow(t, EscalationAutoConfirmWindow, 30)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})
	waitFor(t, func() bool { return len(svc.PendingMigrations()) == 1 })

	if err := svc.CancelMigration(wfID, "active"); err != nil {
		t.Fatalf("CancelMigration() error = %v", err)
	}
	if got := svc.PendingMigrations(); len(got) != 0 {
		t.Fatalf("PendingMigrations() after cancel = %+v, want empty", got)
	}

	time.Sleep(100 * time.Millisecond)
	l.mu.Lock()
	started := len(l.started)
	l.mu.Unlock()
	if started != 2 {
		t.Fatalf("started = %d, want 2 (cancel must not start a replacement instance)", started)
	}

	// Cooldown: ein sofort erneut eintreffender Alarm für dieselbe
	// Instanz darf nicht direkt wieder einen Timer aufsetzen (sonst
	// würde die Bedienerentscheidung faktisch ignoriert).
	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})
	time.Sleep(100 * time.Millisecond)
	if got := svc.PendingMigrations(); len(got) != 0 {
		t.Fatalf("PendingMigrations() after re-raise during cooldown = %+v, want empty", got)
	}
}

func TestOnAdviceClearedCancelsPendingMigration(t *testing.T) {
	svc, _, _, l, _, activeInstance := setupMigrationWorkflow(t, EscalationAutoConfirmWindow, 30)

	svc.OnAdviceRaised(placement.Advice{
		HostID: "host-a", InstanceIDs: []string{activeInstance},
		SuggestedHostID: "host-b", SuggestedHostLabel: "Host B",
	})
	waitFor(t, func() bool { return len(svc.PendingMigrations()) == 1 })

	svc.OnAdviceCleared("host-a")

	if got := svc.PendingMigrations(); len(got) != 0 {
		t.Fatalf("PendingMigrations() after OnAdviceCleared = %+v, want empty", got)
	}
	time.Sleep(100 * time.Millisecond)
	l.mu.Lock()
	started := len(l.started)
	l.mu.Unlock()
	if started != 2 {
		t.Fatalf("started = %d, want 2 (a cleared alarm must not still migrate)", started)
	}
}

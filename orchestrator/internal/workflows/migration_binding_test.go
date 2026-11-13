package workflows

import (
	"context"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// TestExecuteMigrationMovesControlPlaneBinding — ein Control-Plane-Node (Automation, Studio-Logik, ...) holt sein
// Service-Token über eine Bindung auf seine Instanz-ID. Beim Umzug (Host-Wartung, Überlast, Drag) bekommt die Rolle
// eine neue Instanz: sie braucht eine eigene Bindung, die der alten Instanz muss verschwinden.
func TestExecuteMigrationMovesControlPlaneBinding(t *testing.T) {
	svc, nodes, _, l, wfID, activeInstance := setupMigrationWorkflow(t, "", 0)
	binder := &fakeAuthzBinder{}
	svc.authz = binder
	svc.RegisterControlPlaneType("omp-viewer")
	if _, err := binder.Create(activeInstance, wfID, authz.AnyNode, authz.VerbOperate); err != nil { // wie von runStart angelegt
		t.Fatalf("seed binding: %v", err)
	}

	if err := svc.MigrateRole(context.Background(), wfID, "active", "host-b"); err != nil {
		t.Fatalf("MigrateRole() error = %v", err)
	}
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-active-2", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active-2"}}})

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
	waitFor(t, func() bool {
		subjects := map[string]bool{}
		for _, b := range binder.snapshot() {
			if b.WorkflowID == wfID {
				subjects[b.Subject] = true
			}
		}
		return subjects[newInstance] && !subjects[activeInstance]
	})
}

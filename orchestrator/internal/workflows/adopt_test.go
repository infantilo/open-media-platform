package workflows

import (
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func TestAdoptInstanceAddsRuntimeRoleOnlyForRunningWorkflow(t *testing.T) {
	store := newFakeStore()
	nodes := &fakeNodeLister{}
	svc := &Service{store: store, nodes: nodes, migrations: newMigrationState()}
	nodes.add(registry.NodeView{ID: "n-new", InstanceID: "i-new"})
	nodes.add(registry.NodeView{ID: "n-other", InstanceID: "i-other"})
	wf := Workflow{ID: "wf1", Name: "regie", Status: StatusStarted,
		Definition: Definition{Roles: []Role{{Name: "mix", NodeType: "omp-video-mixer-me"}}},
		Runtime:    map[string]RoleRuntime{"mix": {InstanceID: "i-mix", NodeID: "n-mix"}}}
	store.Put(wf)
	store.Put(Workflow{ID: "wf2", Status: StatusStarted, Runtime: map[string]RoleRuntime{"x": {InstanceID: "i-other", NodeID: "n-other"}}})

	got, err := svc.AdoptInstance("wf1", "omp-ograf", "i-new", "n-new", "")
	if err != nil {
		t.Fatalf("AdoptInstance() error = %v", err)
	}
	if rt := got.Runtime["omp-ograf"]; rt.InstanceID != "i-new" || rt.NodeID != "n-new" {
		t.Fatalf("Runtime = %+v", got.Runtime)
	}
	if _, ok := roleByName(got, "omp-ograf"); ok {
		t.Fatal("die Definition darf sich nicht ändern (dauerhaft erst durch Speichern)")
	}
	if saved, _ := store.Get("wf1"); saved.Runtime["omp-ograf"].InstanceID != "i-new" {
		t.Fatal("Eintrag nicht gespeichert")
	}

	// Gleiche Rolle noch einmal, Rolle der Definition, fremde Instanz, falscher Node, leere Angaben.
	if _, err := svc.AdoptInstance("wf1", "omp-ograf", "i-new", "n-new", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("doppelte Rolle: %v", err)
	}
	if _, err := svc.AdoptInstance("wf1", "mix", "i-new", "n-new", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("Rolle der Definition: %v", err)
	}
	if _, err := svc.AdoptInstance("wf1", "andere", "i-other", "n-other", ""); !errors.Is(err, ErrInstanceTaken) {
		t.Fatalf("Instanz eines anderen Workflows: %v", err)
	}
	if _, err := svc.AdoptInstance("wf1", "andere", "i-new", "n-other", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("Node passt nicht zur Instanz: %v", err)
	}
	if _, err := svc.AdoptInstance("wf1", "", "i-new", "n-new", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("leere Rolle: %v", err)
	}

	// Nur ein LAUFENDER Workflow nimmt Instanzen auf.
	store.Put(Workflow{ID: "wf3", Status: StatusStopped})
	if _, err := svc.AdoptInstance("wf3", "r", "i-new", "n-new", ""); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("gestoppter Workflow: %v", err)
	}
}

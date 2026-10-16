package workflows

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// TestUnrestoredRoleIsNotOverwrittenByEmptyCapture (Nutzerfund 2026-10-16):
// ein Node, der nach Start/Umzug noch leer ist, darf den gespeicherten
// Zustand weder per Stop/Backup (captureAuto) noch per Transfer überschreiben.
func TestUnrestoredRoleIsNotOverwrittenByEmptyCapture(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/state" {
			_, _ = w.Write([]byte(`{"state":{"channels":[]}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	store := newFakeStore()
	nodes := &fakeNodeLister{}
	svc := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	wf := Workflow{ID: "wf1", Runtime: map[string]RoleRuntime{"mix": {InstanceID: "i1", NodeID: "n1"}}}

	good := json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"channels":["a","b"]}}}`)
	if err := store.SetRoleState(wf.ID, "mix", good); err != nil {
		t.Fatal(err)
	}
	read := func() string {
		m, _ := store.GetRoleState(wf.ID)
		return string(m["mix"])
	}

	svc.markUnrestored(wf.ID, "mix")
	svc.captureRoleState(wf)
	svc.captureOneRoleState(wf, "mix", nil)
	if got := read(); got != string(good) {
		t.Fatalf("unrestored role was overwritten: %s", got)
	}

	svc.clearUnrestored(wf.ID, "mix")
	svc.captureRoleState(wf)
	if got := read(); got == string(good) {
		t.Fatalf("after restore the role must be captured again, still %s", got)
	}
}

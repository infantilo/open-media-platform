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
		return string(stripUnrestoredMarker(m["mix"]))
	}

	svc.markUnrestored(wf.ID, "mix")
	svc.captureRoleState(wf)
	svc.captureOneRoleState(wf, "mix", nil)
	if got := read(); !stateMatches(json.RawMessage(got), good) {
		t.Fatalf("unrestored role was overwritten: %s", got)
	}

	svc.clearUnrestored(wf.ID, "mix")
	svc.captureRoleState(wf)
	if got := read(); stateMatches(json.RawMessage(got), good) {
		t.Fatalf("after restore the role must be captured again, still %s", got)
	}
}

// Der Merker steht im gespeicherten Eintrag: ein neuer Service (Orchestrator-
// Neustart) darf den guten Zustand ebenfalls nicht mit dem leeren Ist-Stand
// überschreiben (Nutzerfund 2026-11-05).
func TestUnrestoredMarkerSurvivesOrchestratorRestart(t *testing.T) {
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
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	wf := Workflow{ID: "wf1", Runtime: map[string]RoleRuntime{"mix": {InstanceID: "i1", NodeID: "n1"}}}
	good := json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"channels":["a","b"]}}}`)
	_ = store.SetRoleState(wf.ID, "mix", good)

	old := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	old.markSavedRolesUnrestored(wf.ID)

	fresh := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	fresh.captureRoleState(wf)
	m, _ := store.GetRoleState(wf.ID)
	if !stateMatches(stripUnrestoredMarker(m["mix"]), good) {
		t.Fatalf("state overwritten after restart: %s", m["mix"])
	}
	// Eine erfolgreiche Wiederherstellung hebt den Merker auf.
	fresh.clearUnrestored(wf.ID, "mix")
	m, _ = store.GetRoleState(wf.ID)
	if hasUnrestoredMarker(m["mix"]) {
		t.Fatalf("marker still set: %s", m["mix"])
	}
}

func TestStateCarriesIDsIgnoresNormalisedFields(t *testing.T) {
	want := json.RawMessage(`{"programSenderId":"S1","transRateFrames":50,"pinnedSenderIds":["S1","S2"]}`)
	after := json.RawMessage(`{"programSenderId":"S1","transRateFrames":50,"pinnedSenderIds":["S1","S2"],"pipSlots":[{"z":4}],"extra":1}`)
	if !stateCarriesIDs(after, want, []string{"S1", "S2"}) {
		t.Fatal("extra node fields must not matter")
	}
	missing := json.RawMessage(`{"programSenderId":null,"pinnedSenderIds":["S1","S2"]}`)
	if stateCarriesIDs(missing, want, []string{"S1", "S2"}) {
		t.Fatal("missing program id must fail")
	}
}

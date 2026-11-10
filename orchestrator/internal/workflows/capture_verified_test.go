package workflows

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func captureFixture(t *testing.T, handler http.HandlerFunc) (*Service, *fakeStore, Workflow) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	store := newFakeStore()
	nodes := &fakeNodeLister{}
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	wf := Workflow{ID: "wf1", Runtime: map[string]RoleRuntime{"mix": {InstanceID: "i1", NodeID: "n1"}}}
	svc := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	return svc, store, wf
}

// Ein einmaliger Aussetzer von GET /state beim Stop darf die Sicherung nicht verlieren: wiederholen statt still überspringen.
func TestCaptureRetriesTransientStateFailure(t *testing.T) {
	var calls atomic.Int32
	svc, store, wf := captureFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/state" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"state":{"programSenderId":"x","pips":[1,2,3]}}`))
	})
	if err := svc.captureRoleStateMode(wf, "mix", nil, captureAuto); err != nil {
		t.Fatalf("capture: %v", err)
	}
	m, _ := store.GetRoleState(wf.ID)
	if len(m["mix"]) == 0 || calls.Load() != 2 {
		t.Fatalf("state not captured after retry (calls=%d, saved=%s)", calls.Load(), m["mix"])
	}
}

// Dauerhaft kaputtes /state: Fehler wird gemeldet (nicht still), der alte Stand bleibt unverändert.
func TestCaptureReportsFailureAndKeepsOldState(t *testing.T) {
	svc, store, wf := captureFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	old := json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"a":1}}}`)
	_ = store.SetRoleState(wf.ID, "mix", old)
	err := svc.captureRoleStateMode(wf, "mix", nil, captureAuto)
	if err == nil {
		t.Fatal("expected an error for a node whose /state keeps failing")
	}
	m, _ := store.GetRoleState(wf.ID)
	if string(m["mix"]) != string(old) {
		t.Fatalf("old state must stay untouched: %s", m["mix"])
	}
}

// Node ohne /state-Route (404) und ohne Parameter ist kein Fehler.
func TestCaptureNoStateRouteIsNotAnError(t *testing.T) {
	svc, _, wf := captureFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotFound) })
	if err := svc.captureRoleStateMode(wf, "mix", nil, captureAuto); err != nil {
		t.Fatalf("404 must not be an error: %v", err)
	}
}

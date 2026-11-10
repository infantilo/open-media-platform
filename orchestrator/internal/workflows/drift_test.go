package workflows

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func TestSameOperatingStateIgnoresVolatile(t *testing.T) {
	a := json.RawMessage(`{"state":{"programSenderId":"x","levels":[1,2],"peakDb":-3}}`)
	b := json.RawMessage(`{"state":{"programSenderId":"x","levels":[9,9],"peakDb":-40}}`)
	if !sameOperatingState(a, b) {
		t.Fatal("volatile meter values must not count as drift")
	}
	c := json.RawMessage(`{"state":{"programSenderId":"y","levels":[1,2]}}`)
	if sameOperatingState(a, c) {
		t.Fatal("a changed program must count as drift")
	}
}

// Warnung vor dem Stop: nur gepinnte Rollen, deren Live-Stand vom gespeicherten abweicht.
func TestPinnedDriftListsOnlyChangedPinnedRoles(t *testing.T) {
	live := `{"state":{"programSenderId":"B","levels":[5]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(live))
	}))
	defer srv.Close()
	store := newFakeStore()
	nodes := &fakeNodeLister{}
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	nodes.add(registry.NodeView{ID: "n2", InstanceID: "i2", APIBaseURL: srv.URL})
	wf := Workflow{ID: "wf1", Status: StatusStarted, Runtime: map[string]RoleRuntime{
		"same":    {InstanceID: "i1", NodeID: "n1"},
		"changed": {InstanceID: "i2", NodeID: "n2"},
	}}
	_ = store.Put(wf)
	_ = store.SetRoleState("wf1", "same", json.RawMessage(`{"__kind":"node-state","__pinned":true,"__blob":{"state":{"programSenderId":"B","levels":[1]}}}`))
	_ = store.SetRoleState("wf1", "changed", json.RawMessage(`{"__kind":"node-state","__pinned":true,"__blob":{"state":{"programSenderId":"A"}}}`))
	_ = store.SetRoleState("wf1", "unpinned", json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"programSenderId":"A"}}}`))
	svc := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	got, err := svc.PinnedDrift("wf1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "changed" {
		t.Fatalf("drift = %v, want [changed]", got)
	}
}

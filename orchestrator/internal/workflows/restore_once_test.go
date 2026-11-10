package workflows

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Nutzerfund 2026-11-10: der minütliche Wiederherstellungs-Retry spielte den gespeicherten Bildmischer-Zustand
// (Programm = Player A, Flow noch nicht da → „did not stick“) immer wieder ein und überschrieb so den Take der
// Playout-Automation; der Monitor blieb schwarz. Der gespeicherte Stand darf pro Start nur EINMAL zugestellt werden.
func TestRetryNeverPostsSavedStateTwice(t *testing.T) {
	var mu sync.Mutex
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/state":
			_, _ = io.ReadAll(r.Body)
			mu.Lock()
			posts++
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodGet && r.URL.Path == "/state":
			// Der Node hält das Programm als „ausstehend“ (Quelle ohne Flow): im Zustand steht es nicht.
			_, _ = w.Write([]byte(`{"state":{"programSenderId":null}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	nodes := &fakeNodeLister{}
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	nodes.add(registry.NodeView{ID: "n2", InstanceID: "i2", APIBaseURL: srv.URL, Senders: []registry.SenderView{{ID: "S-A"}}})
	wf := Workflow{ID: "wf1", Runtime: map[string]RoleRuntime{
		"mix":      {InstanceID: "i1", NodeID: "n1"},
		"Player A": {InstanceID: "i2", NodeID: "n2"},
	}}
	saved := json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"programSenderId":"` + senderAliasPrefix + `Player A:0"}}}`)
	_ = store.SetRoleState(wf.ID, "mix", saved)
	svc := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	svc.markSavedRolesUnrestored(wf.ID)

	// Erster Durchlauf (Start): Zustellung ok, Verifikation scheitert (ausstehendes Programm).
	if err := svc.restoreOneRoleStateN(wf, "mix", saved, 1); err == nil {
		t.Fatal("first run: expected verify failure")
	}
	if posts != 1 {
		t.Fatalf("posts after first run = %d, want 1", posts)
	}
	// Spätere Retry-Runden: nie wieder einspielen; Rolle gilt als wiederhergestellt (Live-Änderungen werden erfasst).
	for i := 0; i < 3; i++ {
		if err := svc.restoreOneRoleStateN(wf, "mix", saved, 1); err != nil {
			t.Fatalf("retry %d: %v", i, err)
		}
	}
	if posts != 1 {
		t.Fatalf("saved state was posted %d times, want exactly 1", posts)
	}
	if svc.isUnrestored(wf.ID, "mix") {
		t.Fatal("role must count as restored after delivery")
	}
	// Neuer Start (markUnrestored) darf wieder einspielen.
	svc.markUnrestored(wf.ID, "mix")
	_ = svc.restoreOneRoleStateN(wf, "mix", saved, 1)
	if posts != 2 {
		t.Fatalf("posts after new start = %d, want 2", posts)
	}
}

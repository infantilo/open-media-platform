package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// TestHeldStateSurvivesBackupAndIsRestoredOnlyOnRequest — nach einem Absturz-Neustart ist der Node leer. Sein
// gesicherter Stand darf von der periodischen Sicherung nicht überschrieben und NICHT von selbst eingespielt werden;
// erst RestoreHeldState bringt ihn in den Node, DiscardHeldState gibt ihn auf.
func TestHeldStateSurvivesBackupAndIsRestoredOnlyOnRequest(t *testing.T) {
	var mu sync.Mutex
	live := `{"state":{"channels":[]}}` // leerer Node nach dem Neustart
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/state":
			_, _ = w.Write([]byte(live))
		case r.Method == http.MethodPost && r.URL.Path == "/state":
			body, _ := io.ReadAll(r.Body)
			live = string(body)
			posts++
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	nodes := &fakeNodeLister{}
	svc := &Service{store: store, nodes: nodes, httpClient: http.DefaultClient, migrations: newMigrationState()}
	nodes.add(registry.NodeView{ID: "n1", InstanceID: "i1", APIBaseURL: srv.URL})
	wf := Workflow{ID: "wf1", Name: "regie", Status: StatusStarted,
		Definition: Definition{Roles: []Role{{Name: "mix", NodeType: "omp-audio-mixer"}}},
		Runtime:    map[string]RoleRuntime{"mix": {InstanceID: "i1", NodeID: "n1"}}}
	store.Put(wf)
	good := json.RawMessage(`{"__kind":"node-state","__blob":{"state":{"channels":["a","b"]}}}`)
	if err := store.SetRoleState(wf.ID, "mix", good); err != nil {
		t.Fatal(err)
	}
	saved := func() json.RawMessage {
		m, _ := store.GetRoleState(wf.ID)
		return stripMarker(m["mix"], heldMarkerKey)
	}

	if !svc.setStateHold(wf.ID, "mix", true) {
		t.Fatal("setStateHold reported no change")
	}
	if held, err := svc.HeldStates(wf.ID); err != nil || len(held) != 1 || held[0] != "mix" {
		t.Fatalf("HeldStates = %v, %v, want [mix]", held, err)
	}

	// Sicherung, Transfer und die Wiederholungsrunde lassen den gehaltenen Stand in Ruhe — und spielen nichts ein.
	svc.captureRoleState(wf)
	svc.captureOneRoleState(wf, "mix", nil)
	svc.retryUnrestored(wf)
	if !stateMatches(saved(), good) {
		t.Fatalf("held state was overwritten: %s", saved())
	}
	mu.Lock()
	if posts != 0 {
		t.Fatalf("held state was restored automatically (%d posts)", posts)
	}
	mu.Unlock()

	// Bedienerentscheidung: einspielen.
	if err := svc.RestoreHeldState(context.Background(), wf.ID, "mix"); err != nil {
		t.Fatalf("RestoreHeldState() error = %v", err)
	}
	mu.Lock()
	if posts != 1 {
		t.Fatalf("posts after RestoreHeldState = %d, want 1", posts)
	}
	mu.Unlock()
	if held, _ := svc.HeldStates(wf.ID); len(held) != 0 {
		t.Fatalf("hold not released after restore: %v", held)
	}
	if err := svc.RestoreHeldState(context.Background(), wf.ID, "mix"); !errors.Is(err, ErrNoHeldState) {
		t.Fatalf("second RestoreHeldState() error = %v, want ErrNoHeldState", err)
	}

	// Verwerfen: danach überschreibt die Sicherung den alten Stand wieder.
	mu.Lock()
	live = `{"state":{"channels":["neu"]}}`
	mu.Unlock()
	_ = store.SetRoleState(wf.ID, "mix", good)
	svc.setStateHold(wf.ID, "mix", true)
	if err := svc.DiscardHeldState(wf.ID, "mix"); err != nil {
		t.Fatalf("DiscardHeldState() error = %v", err)
	}
	svc.captureRoleState(wf)
	if stateMatches(saved(), good) {
		t.Fatalf("after discarding the hold the backup must capture the live state again")
	}
	if err := svc.DiscardHeldState(wf.ID, "mix"); !errors.Is(err, ErrNoHeldState) {
		t.Fatalf("second DiscardHeldState() error = %v, want ErrNoHeldState", err)
	}
}

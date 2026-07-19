package snapshots

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeNodeLister struct{ nodes []registry.NodeView }

func (f fakeNodeLister) List() []registry.NodeView { return f.nodes }

type fakeGraphService struct {
	g             graph.Graph
	connectCalls  []Edge
	connectErrors map[string]error
}

func (f *fakeGraphService) Graph(ctx context.Context) graph.Graph { return f.g }

func (f *fakeGraphService) Connect(ctx context.Context, fromSender, toReceiver string) error {
	f.connectCalls = append(f.connectCalls, Edge{FromSender: fromSender, ToReceiver: toReceiver})
	if f.connectErrors != nil {
		if err, ok := f.connectErrors[toReceiver]; ok {
			return err
		}
	}
	return nil
}

type fakeStore struct {
	snaps map[string]Snapshot
}

func newFakeStore() *fakeStore { return &fakeStore{snaps: map[string]Snapshot{}} }

func (f *fakeStore) Put(snap Snapshot) error {
	f.snaps[snap.ID] = snap
	return nil
}

func (f *fakeStore) Get(id string) (Snapshot, error) {
	snap, ok := f.snaps[id]
	if !ok {
		return Snapshot{}, ErrNotFound
	}
	return snap, nil
}

func (f *fakeStore) List() ([]Snapshot, error) {
	out := make([]Snapshot, 0, len(f.snaps))
	for _, s := range f.snaps {
		out = append(out, s)
	}
	return out, nil
}

type fakeNodeClient struct {
	writableParams map[string][]string        // baseURL -> param names
	values         map[string]json.RawMessage // baseURL+"/"+name -> value
	patched        map[string]json.RawMessage
	patchErrors    map[string]error
	states         map[string]json.RawMessage // baseURL -> state (absent = /state not supported)
	appliedStates  map[string]json.RawMessage
}

func newFakeNodeClient() *fakeNodeClient {
	return &fakeNodeClient{
		writableParams: map[string][]string{},
		values:         map[string]json.RawMessage{},
		patched:        map[string]json.RawMessage{},
		patchErrors:    map[string]error{},
		states:         map[string]json.RawMessage{},
		appliedStates:  map[string]json.RawMessage{},
	}
}

// GetState/ApplyState: fehlt baseURL in f.states, verhält sich der Fake
// wie ein Node ohne /state-Route (ok==false, kein Fehler) — deckt sich
// mit dem echten httpNodeClient-Verhalten bei 404.
func (f *fakeNodeClient) GetState(ctx context.Context, baseURL string) (json.RawMessage, bool, error) {
	state, ok := f.states[baseURL]
	return state, ok, nil
}

func (f *fakeNodeClient) ApplyState(ctx context.Context, baseURL string, state json.RawMessage) (bool, error) {
	if _, ok := f.states[baseURL]; !ok {
		return false, nil
	}
	f.appliedStates[baseURL] = state
	return true, nil
}

func (f *fakeNodeClient) GetWritableParams(ctx context.Context, baseURL string) ([]string, error) {
	return f.writableParams[baseURL], nil
}

func (f *fakeNodeClient) GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error) {
	return f.values[baseURL+"/"+name], nil
}

func (f *fakeNodeClient) PatchParam(ctx context.Context, baseURL, name string, value json.RawMessage) error {
	key := baseURL + "/" + name
	if err, ok := f.patchErrors[key]; ok {
		return err
	}
	f.patched[key] = value
	return nil
}

func newTestService(nodes []registry.NodeView, g graph.Graph, store *fakeStore, client *fakeNodeClient) (*Service, *fakeGraphService) {
	graphSvc := &fakeGraphService{g: g}
	svc := &Service{
		nodes:  fakeNodeLister{nodes: nodes},
		graph:  graphSvc,
		store:  store,
		client: client,
	}
	return svc, graphSvc
}

func TestCreateCapturesEdgesAndWritableParams(t *testing.T) {
	nodes := []registry.NodeView{{ID: "node-1", APIBaseURL: "http://node-1"}}
	g := graph.Graph{Edges: []graph.Edge{{ID: "recv-1", FromSender: "send-1", ToReceiver: "recv-1"}}}

	client := newFakeNodeClient()
	client.writableParams["http://node-1"] = []string{"gain"}
	client.values["http://node-1/gain"] = json.RawMessage(`-6`)

	svc, _ := newTestService(nodes, g, newFakeStore(), client)

	snap, err := svc.Create(context.Background(), "Szene 1", nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if snap.Label != "Szene 1" {
		t.Errorf("Label = %q, want Szene 1", snap.Label)
	}
	if len(snap.Edges) != 1 || snap.Edges[0].FromSender != "send-1" {
		t.Fatalf("Edges = %+v, want one send-1->recv-1", snap.Edges)
	}
	if len(snap.Params) != 1 || snap.Params[0].Name != "gain" || string(snap.Params[0].Value) != "-6" {
		t.Fatalf("Params = %+v, want one gain=-6", snap.Params)
	}
}

// TestCreateWithNodeIDsScopesToThoseNodesAndOmitsEdges (§4.6 Punkt 4,
// docs/END-GOAL-FEATURES.md "Mixer-Presets"): ein Node-Preset erfasst
// nur die Parameter der genannten Node(s), lässt Kanten bewusst weg,
// auch wenn welche im Graph existieren.
func TestCreateWithNodeIDsScopesToThoseNodesAndOmitsEdges(t *testing.T) {
	nodes := []registry.NodeView{
		{ID: "node-1", APIBaseURL: "http://node-1"},
		{ID: "node-2", APIBaseURL: "http://node-2"},
	}
	g := graph.Graph{Edges: []graph.Edge{{ID: "recv-1", FromSender: "send-1", ToReceiver: "recv-1"}}}

	client := newFakeNodeClient()
	client.writableParams["http://node-1"] = []string{"gain"}
	client.values["http://node-1/gain"] = json.RawMessage(`-6`)
	client.writableParams["http://node-2"] = []string{"gain"}
	client.values["http://node-2/gain"] = json.RawMessage(`3`)

	svc, _ := newTestService(nodes, g, newFakeStore(), client)

	snap, err := svc.Create(context.Background(), "Mixer-Preset A", []string{"node-1"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(snap.Edges) != 0 {
		t.Errorf("Edges = %+v, want none (node-scoped preset)", snap.Edges)
	}
	if len(snap.Params) != 1 || snap.Params[0].NodeID != "node-1" {
		t.Fatalf("Params = %+v, want exactly one param for node-1", snap.Params)
	}
	if len(snap.NodeIDs) != 1 || snap.NodeIDs[0] != "node-1" {
		t.Errorf("NodeIDs = %+v, want [node-1]", snap.NodeIDs)
	}
}

// TestCreatePrefersNodeStateOverWritableParams (docs/decisions.md
// Nachtrag 40, "Mixer-Presets"-Blocker): ein Node, der GetState
// unterstützt, wird darüber erfasst statt über die (für ihn ggf. leere,
// da alles readonly) Parameter-Enumeration — und beide Wege schließen
// sich für denselben Node gegenseitig aus.
func TestCreatePrefersNodeStateOverWritableParams(t *testing.T) {
	nodes := []registry.NodeView{{ID: "node-1", APIBaseURL: "http://node-1"}}

	client := newFakeNodeClient()
	client.states["http://node-1"] = json.RawMessage(`{"channels":[{"id":"ch1","gainDb":-12}]}`)
	// Sollte ignoriert werden, weil GetState bereits greift.
	client.writableParams["http://node-1"] = []string{"gain"}
	client.values["http://node-1/gain"] = json.RawMessage(`0`)

	svc, _ := newTestService(nodes, graph.Graph{}, newFakeStore(), client)

	snap, err := svc.Create(context.Background(), "Mixer-Preset A", []string{"node-1"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if len(snap.Params) != 0 {
		t.Errorf("Params = %+v, want none (node captured via /state)", snap.Params)
	}
	if len(snap.States) != 1 || snap.States[0].NodeID != "node-1" {
		t.Fatalf("States = %+v, want exactly one state for node-1", snap.States)
	}
	if string(snap.States[0].State) != `{"channels":[{"id":"ch1","gainDb":-12}]}` {
		t.Errorf("States[0].State = %s, want the captured JSON unchanged", snap.States[0].State)
	}
}

func TestApplyRestoresNodeStateBeforeParams(t *testing.T) {
	nodes := []registry.NodeView{{ID: "node-1", APIBaseURL: "http://node-1"}}
	store := newFakeStore()
	client := newFakeNodeClient()
	client.states["http://node-1"] = json.RawMessage(`{}`)
	svc, _ := newTestService(nodes, graph.Graph{}, store, client)

	snap := Snapshot{
		ID:     "s1",
		States: []NodeState{{NodeID: "node-1", State: json.RawMessage(`{"channels":[]}`)}},
	}
	_ = store.Put(snap)

	result, err := svc.Apply(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("Errors = %v, want none", result.Errors)
	}
	if string(client.appliedStates["http://node-1"]) != `{"channels":[]}` {
		t.Errorf("appliedStates = %s, want the snapshot's state unchanged", client.appliedStates["http://node-1"])
	}
}

func TestCreatePersistsSnapshotForLaterRetrieval(t *testing.T) {
	store := newFakeStore()
	svc, _ := newTestService(nil, graph.Graph{}, store, newFakeNodeClient())

	snap, err := svc.Create(context.Background(), "Szene 1", nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	list, err := svc.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 1 || list[0].ID != snap.ID {
		t.Fatalf("List() = %+v, want one snapshot with ID %s", list, snap.ID)
	}
}

func TestApplyRestoresParamsBeforeEdges(t *testing.T) {
	nodes := []registry.NodeView{{ID: "node-1", APIBaseURL: "http://node-1"}}
	store := newFakeStore()
	client := newFakeNodeClient()
	svc, graphSvc := newTestService(nodes, graph.Graph{}, store, client)

	snap := Snapshot{
		ID:     "s1",
		Params: []ParamValue{{NodeID: "node-1", Name: "gain", Value: json.RawMessage(`-6`)}},
		Edges:  []Edge{{FromSender: "send-1", ToReceiver: "recv-1"}},
	}
	_ = store.Put(snap)

	result, err := svc.Apply(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("Errors = %v, want none", result.Errors)
	}

	if string(client.patched["http://node-1/gain"]) != "-6" {
		t.Errorf("patched gain = %s, want -6", client.patched["http://node-1/gain"])
	}
	if len(graphSvc.connectCalls) != 1 || graphSvc.connectCalls[0].FromSender != "send-1" {
		t.Fatalf("connectCalls = %+v, want one send-1->recv-1", graphSvc.connectCalls)
	}
}

func TestApplyCollectsErrorsWithoutStopping(t *testing.T) {
	nodes := []registry.NodeView{{ID: "node-1", APIBaseURL: "http://node-1"}}
	store := newFakeStore()
	client := newFakeNodeClient()
	client.patchErrors["http://node-1/gain"] = errPatchFailed
	svc, graphSvc := newTestService(nodes, graph.Graph{}, store, client)

	snap := Snapshot{
		ID: "s1",
		Params: []ParamValue{
			{NodeID: "node-1", Name: "gain", Value: json.RawMessage(`-6`)},
			{NodeID: "does-not-exist", Name: "x", Value: json.RawMessage(`1`)},
		},
		Edges: []Edge{{FromSender: "send-1", ToReceiver: "recv-1"}},
	}
	_ = store.Put(snap)

	result, err := svc.Apply(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if len(result.Errors) != 2 {
		t.Fatalf("Errors = %+v, want 2 errors (failed patch + unknown node)", result.Errors)
	}
	// Kanten werden trotz Parameter-Fehlern weiterhin angewendet.
	if len(graphSvc.connectCalls) != 1 {
		t.Fatalf("connectCalls = %+v, want edges still applied despite param errors", graphSvc.connectCalls)
	}
}

func TestApplyUnknownSnapshotReturnsError(t *testing.T) {
	svc, _ := newTestService(nil, graph.Graph{}, newFakeStore(), newFakeNodeClient())
	_, err := svc.Apply(context.Background(), "does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("Apply() error = %v, want ErrNotFound", err)
	}
}

var errPatchFailed = &patchError{"patch failed"}

type patchError struct{ msg string }

func (e *patchError) Error() string { return e.msg }

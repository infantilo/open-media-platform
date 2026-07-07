package graph

import (
	"context"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func strPtr(s string) *string { return &s }

func TestBuildNodesMapsPortsAndHealth(t *testing.T) {
	views := []registry.NodeView{{
		ID: "node-1", Label: "Node 1", Online: true,
		Senders:   []registry.SenderView{{ID: "send-1", Label: "Sender 1", Format: "urn:x-nmos:format:video"}},
		Receivers: []registry.ReceiverView{{ID: "recv-1", Label: "Receiver 1", Format: "urn:x-nmos:format:video"}},
	}}

	nodes := buildNodes(views)

	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	n := nodes[0]
	if n.Health != "ok" {
		t.Errorf("Health = %q, want ok", n.Health)
	}
	if len(n.Outputs) != 1 || n.Outputs[0].ID != "send-1" || n.Outputs[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("Outputs = %+v, want one send-1 with video format", n.Outputs)
	}
	if len(n.Inputs) != 1 || n.Inputs[0].ID != "recv-1" || n.Inputs[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("Inputs = %+v, want one recv-1 with video format", n.Inputs)
	}
}

func TestBuildNodesOfflineHealth(t *testing.T) {
	views := []registry.NodeView{{ID: "node-1", Online: false}}
	nodes := buildNodes(views)
	if nodes[0].Health != "offline" {
		t.Errorf("Health = %q, want offline", nodes[0].Health)
	}
}

func TestFindNodeByReceiver(t *testing.T) {
	views := []registry.NodeView{
		{ID: "node-1", Receivers: []registry.ReceiverView{{ID: "recv-1"}}},
		{ID: "node-2", Receivers: []registry.ReceiverView{{ID: "recv-2"}}},
	}

	n, ok := findNodeByReceiver(views, "recv-2")
	if !ok || n.ID != "node-2" {
		t.Fatalf("findNodeByReceiver = %+v, %v; want node-2, true", n, ok)
	}

	_, ok = findNodeByReceiver(views, "does-not-exist")
	if ok {
		t.Fatal("findNodeByReceiver(unknown) ok = true, want false")
	}
}

// fakeIS05Client ist ein Test-Double für is05Client, damit Service-Tests
// ohne echte HTTP-Aufrufe an einen Mock-Node auskommen.
type fakeIS05Client struct {
	active  map[string]is05.ActiveResource
	patched map[string]struct {
		senderID     *string
		masterEnable bool
	}
}

func newFakeIS05Client() *fakeIS05Client {
	return &fakeIS05Client{
		active: map[string]is05.ActiveResource{},
		patched: map[string]struct {
			senderID     *string
			masterEnable bool
		}{},
	}
}

func (f *fakeIS05Client) GetActive(ctx context.Context, baseURL, receiverID string) (is05.ActiveResource, error) {
	return f.active[receiverID], nil
}

func (f *fakeIS05Client) PatchStaged(ctx context.Context, baseURL, receiverID string, senderID *string, masterEnable bool) error {
	f.patched[receiverID] = struct {
		senderID     *string
		masterEnable bool
	}{senderID, masterEnable}
	f.active[receiverID] = is05.ActiveResource{SenderID: senderID, MasterEnable: masterEnable}
	return nil
}

type fakeNodeLister struct{ views []registry.NodeView }

func (f fakeNodeLister) List() []registry.NodeView { return f.views }

func TestServiceGraphIncludesActiveEdges(t *testing.T) {
	views := []registry.NodeView{{
		ID: "node-1", APIBaseURL: "http://mock:9001",
		Receivers: []registry.ReceiverView{{ID: "recv-1"}},
	}}
	client := newFakeIS05Client()
	client.active["recv-1"] = is05.ActiveResource{SenderID: strPtr("send-1"), MasterEnable: true}

	svc := NewService(fakeNodeLister{views}, client)
	g := svc.Graph(context.Background())

	if len(g.Edges) != 1 {
		t.Fatalf("edges = %+v, want one edge", g.Edges)
	}
	if g.Edges[0].ID != "recv-1" || g.Edges[0].FromSender != "send-1" || g.Edges[0].ToReceiver != "recv-1" {
		t.Errorf("edge = %+v, unexpected shape", g.Edges[0])
	}
}

func TestServiceGraphOmitsInactiveReceivers(t *testing.T) {
	views := []registry.NodeView{{
		ID: "node-1", APIBaseURL: "http://mock:9001",
		Receivers: []registry.ReceiverView{{ID: "recv-1"}},
	}}
	client := newFakeIS05Client()

	svc := NewService(fakeNodeLister{views}, client)
	g := svc.Graph(context.Background())

	if len(g.Edges) != 0 {
		t.Fatalf("edges = %+v, want none (receiver not connected)", g.Edges)
	}
}

func TestServiceConnectPatchesReceiver(t *testing.T) {
	views := []registry.NodeView{{
		ID: "node-1", APIBaseURL: "http://mock:9001",
		Receivers: []registry.ReceiverView{{ID: "recv-1"}},
	}}
	client := newFakeIS05Client()
	svc := NewService(fakeNodeLister{views}, client)

	if err := svc.Connect(context.Background(), "send-1", "recv-1"); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	patched := client.patched["recv-1"]
	if patched.senderID == nil || *patched.senderID != "send-1" || !patched.masterEnable {
		t.Errorf("patched = %+v, want sender-1/true", patched)
	}
}

func TestServiceConnectUnknownReceiverReturnsError(t *testing.T) {
	svc := NewService(fakeNodeLister{nil}, newFakeIS05Client())
	if err := svc.Connect(context.Background(), "send-1", "does-not-exist"); err != ErrUnknownReceiver {
		t.Fatalf("Connect() error = %v, want ErrUnknownReceiver", err)
	}
}

func TestServiceDisconnectPatchesReceiverWithNilSender(t *testing.T) {
	views := []registry.NodeView{{
		ID: "node-1", APIBaseURL: "http://mock:9001",
		Receivers: []registry.ReceiverView{{ID: "recv-1"}},
	}}
	client := newFakeIS05Client()
	svc := NewService(fakeNodeLister{views}, client)

	if err := svc.Disconnect(context.Background(), "recv-1"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}

	patched := client.patched["recv-1"]
	if patched.senderID != nil || patched.masterEnable {
		t.Errorf("patched = %+v, want nil sender / false", patched)
	}
}

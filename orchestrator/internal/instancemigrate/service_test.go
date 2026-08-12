package instancemigrate

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeNodes struct {
	mu    sync.Mutex
	views []registry.NodeView
}

func (f *fakeNodes) List() []registry.NodeView {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]registry.NodeView, len(f.views))
	copy(out, f.views)
	return out
}

func (f *fakeNodes) add(v registry.NodeView) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.views = append(f.views, v)
}

type fakeLauncher struct {
	mu       sync.Mutex
	byID     map[string]launcher.Instance
	nextID   int
	stopped  []string
	startErr error
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{byID: map[string]launcher.Instance{}}
}

func (f *fakeLauncher) seed(inst launcher.Instance) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[inst.ID] = inst
}

func (f *fakeLauncher) Get(id string) (launcher.Instance, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	inst, ok := f.byID[id]
	return inst, ok
}

func (f *fakeLauncher) StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return launcher.Instance{}, f.startErr
	}
	f.nextID++
	inst := launcher.Instance{ID: fmt.Sprintf("inst-%d", f.nextID), Type: nodeType, Label: customLabel, HostID: hostID}
	f.byID[inst.ID] = inst
	return inst, nil
}

func (f *fakeLauncher) Stop(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.byID, id)
	f.stopped = append(f.stopped, id)
	return nil
}

type connectCall struct{ fromSender, toReceiver string }

type fakeGraph struct {
	mu    sync.Mutex
	g     graph.Graph
	calls []connectCall
}

func (f *fakeGraph) Graph(ctx context.Context) graph.Graph {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.g
}

func (f *fakeGraph) Connect(ctx context.Context, fromSender, toReceiver string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, connectCall{fromSender, toReceiver})
	return nil
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within timeout")
}

// TestMigrateInstanceHappyPath deckt den vollen Ablauf ab: eine
// eigenständige Instanz mit je einem Sender/Receiver, einer externen
// Kante an jedem, wird auf einen anderen Host umgezogen — die neue
// Instanz muss dieselbe (Seite+Index-)Rolle in beiden Kanten
// übernehmen, obwohl ihre Port-IDs neu sind.
func TestMigrateInstanceHappyPath(t *testing.T) {
	original := registrationPollInterval
	registrationPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { registrationPollInterval = original })

	nodes := &fakeNodes{}
	l := newFakeLauncher()
	g := &fakeGraph{}
	svc := NewService(nodes, l, g)

	l.seed(launcher.Instance{ID: "old-1", Type: "omp-scaler", Label: "Scaler (old-1)", HostID: "host-a"})
	nodes.add(registry.NodeView{
		ID:         "node-old",
		InstanceID: "old-1",
		Senders:    []registry.SenderView{{ID: "send-old"}},
		Receivers:  []registry.ReceiverView{{ID: "recv-old"}},
	})
	g.g = graph.Graph{Edges: []graph.Edge{
		{FromSender: "send-old", ToReceiver: "recv-external"},
		{FromSender: "send-external", ToReceiver: "recv-old"},
	}}

	if err := svc.MigrateInstance(context.Background(), "old-1", "host-b"); err != nil {
		t.Fatalf("MigrateInstance() error = %v", err)
	}

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.stopped) == 1 && l.stopped[0] == "old-1"
	})

	var newID string
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for id, inst := range l.byID {
			if inst.Type == "omp-scaler" && inst.HostID == "host-b" {
				newID = id
				return true
			}
		}
		return false
	})

	// Registrierung der neuen Instanz simulieren, sobald der Launcher
	// sie kennt — genau wie ein echter Node-Prozess, der sich beim
	// Registry-Poller meldet.
	nodes.add(registry.NodeView{
		ID:         "node-new",
		InstanceID: newID,
		Senders:    []registry.SenderView{{ID: "send-new"}},
		Receivers:  []registry.ReceiverView{{ID: "recv-new"}},
	})

	waitFor(t, func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.calls) == 2
	})

	g.mu.Lock()
	calls := append([]connectCall{}, g.calls...)
	g.mu.Unlock()

	wantOutbound := connectCall{"send-new", "recv-external"}
	wantInbound := connectCall{"send-external", "recv-new"}
	if calls[0] != wantOutbound && calls[1] != wantOutbound {
		t.Fatalf("Connect calls = %+v, want one of them = %+v", calls, wantOutbound)
	}
	if calls[0] != wantInbound && calls[1] != wantInbound {
		t.Fatalf("Connect calls = %+v, want one of them = %+v", calls, wantInbound)
	}
}

func TestMigrateInstanceRejectsUnknownInstance(t *testing.T) {
	svc := NewService(&fakeNodes{}, newFakeLauncher(), &fakeGraph{})
	err := svc.MigrateInstance(context.Background(), "does-not-exist", "host-b")
	if !errors.Is(err, ErrUnknownInstance) {
		t.Fatalf("MigrateInstance() error = %v, want ErrUnknownInstance", err)
	}
}

func TestMigrateInstanceRejectsSameHost(t *testing.T) {
	l := newFakeLauncher()
	l.seed(launcher.Instance{ID: "old-1", Type: "omp-scaler", HostID: "host-a"})
	svc := NewService(&fakeNodes{}, l, &fakeGraph{})

	err := svc.MigrateInstance(context.Background(), "old-1", "host-a")
	if !errors.Is(err, ErrSameHost) {
		t.Fatalf("MigrateInstance() error = %v, want ErrSameHost", err)
	}
}

func TestMigrateInstanceRejectsUnregisteredInstance(t *testing.T) {
	l := newFakeLauncher()
	l.seed(launcher.Instance{ID: "old-1", Type: "omp-scaler", HostID: "host-a"})
	svc := NewService(&fakeNodes{}, l, &fakeGraph{})

	err := svc.MigrateInstance(context.Background(), "old-1", "host-b")
	if !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("MigrateInstance() error = %v, want ErrNotRegistered", err)
	}
}

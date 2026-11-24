package instancemigrate

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostbridge"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeBridges struct {
	mu    sync.Mutex
	plans []hostbridge.Bridge
	fail  error
	l     *fakeLauncher
}

func (f *fakeBridges) Build(_ context.Context, b hostbridge.Bridge) (*hostbridge.Built, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.plans = append(f.plans, b)
	if f.fail != nil {
		return nil, f.fail
	}
	f.l.seed(launcher.Instance{ID: "br-entry", Type: "gw"})
	f.l.seed(launcher.Instance{ID: "br-exit", Type: "gw"})
	return &hostbridge.Built{Transport: hostbridge.Fabrics, Instances: []string{"br-exit", "br-entry"},
		Entry: registry.NodeView{Receivers: []registry.ReceiverView{{ID: "br-in"}}},
		Exit:  registry.NodeView{Senders: []registry.SenderView{{ID: "br-out"}}}}, nil
}

type failingGraph struct {
	fakeGraph
	failTo string
}

func (f *failingGraph) Connect(ctx context.Context, from, to string) error {
	if to == f.failTo {
		f.mu.Lock()
		f.calls = append(f.calls, connectCall{from, to})
		f.mu.Unlock()
		return errors.New("connect failed")
	}
	return f.fakeGraph.Connect(ctx, from, to)
}

// setupBridged: alter Sender (MXL, Bild) auf host-a, Verbraucher auf host-a, Umzug nach host-b.
func setupBridged(t *testing.T, g GraphService, fg *fakeGraph, vid string) (*Service, *fakeLauncher, *fakeBridges) {
	t.Helper()
	origP, origS := registrationPollInterval, bridgeSettle
	registrationPollInterval, bridgeSettle = 5*time.Millisecond, 0
	t.Cleanup(func() { registrationPollInterval, bridgeSettle = origP, origS })
	nodes := &fakeNodes{}
	l := newFakeLauncher()
	svc := NewService(nodes, l, g)
	fb := &fakeBridges{l: l}
	svc.SetBridges(fb, nil)
	l.seed(launcher.Instance{ID: "old-1", Type: "omp-source", HostID: "host-a"})
	l.seed(launcher.Instance{ID: "peer-1", Type: "omp-viewer", HostID: "host-a"})
	nodes.add(registry.NodeView{ID: "node-old", InstanceID: "old-1", Senders: []registry.SenderView{{ID: "send-old", Transport: "urn:x-nmos:transport:mxl", Format: vid, Width: 1280, Height: 720, RateNum: 50, RateDen: 1}}})
	nodes.add(registry.NodeView{ID: "node-peer", InstanceID: "peer-1", Label: "Viewer", Receivers: []registry.ReceiverView{{ID: "recv-peer"}}})
	fg.g = graph.Graph{Edges: []graph.Edge{{FromSender: "send-old", ToReceiver: "recv-peer"}}}
	l.onStarted = func(in launcher.Instance) {
		nodes.add(registry.NodeView{ID: "node-" + in.ID, InstanceID: in.ID, Senders: []registry.SenderView{{ID: "send-" + in.ID, Transport: "urn:x-nmos:transport:mxl"}}})
	}
	return svc, l, fb
}

func TestMigrateAcrossHostsUsesBridgeMakeBeforeBreak(t *testing.T) {
	fg := &fakeGraph{}
	svc, l, fb := setupBridged(t, fg, fg, "urn:x-nmos:format:video")
	var callsAtStop int
	l.onStop = func(id string) {
		if id == "old-1" {
			fg.mu.Lock()
			callsAtStop = len(fg.calls)
			fg.mu.Unlock()
		}
	}
	if err := svc.MigrateInstanceSync(context.Background(), "old-1", "host-b"); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if len(fb.plans) != 1 {
		t.Fatalf("plans = %d", len(fb.plans))
	}
	p := fb.plans[0]
	if p.SenderHost != "host-b" || p.ReceiverHost != "host-a" || p.Medium != hostbridge.Video || p.Format.Width != 1280 || p.Owner == "" || p.Owner == "old-1" {
		t.Fatalf("plan = %+v", p)
	}
	fg.mu.Lock()
	defer fg.mu.Unlock()
	if len(fg.calls) != 2 {
		t.Fatalf("calls = %v", fg.calls)
	}
	newSender := "send-" + p.Owner
	if fg.calls[0] != (connectCall{newSender, "br-in"}) || fg.calls[1] != (connectCall{"br-out", "recv-peer"}) {
		t.Fatalf("calls = %v", fg.calls)
	}
	if callsAtStop != 2 {
		t.Fatalf("old instance stopped after %d connects, want 2 (make-before-break)", callsAtStop)
	}
}

func TestBridgeBuildFailureLeavesOldInstanceRunning(t *testing.T) {
	fg := &fakeGraph{}
	svc, l, fb := setupBridged(t, fg, fg, "urn:x-nmos:format:video")
	fb.fail = errors.New("no gateway binary")
	err := svc.MigrateInstanceSync(context.Background(), "old-1", "host-b")
	if err == nil {
		t.Fatal("want error")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, alive := l.byID["old-1"]; !alive {
		t.Fatal("old instance must keep running")
	}
	for id := range l.byID {
		if id != "old-1" && id != "peer-1" {
			t.Fatalf("leftover instance %s", id)
		}
	}
	if len(fg.calls) != 0 {
		t.Fatalf("no connections expected, got %v", fg.calls)
	}
}

func TestBridgeSwitchFailureRollsBackToOldInstance(t *testing.T) {
	fg := &failingGraph{failTo: "recv-peer"}
	svc, l, _ := setupBridged(t, fg, &fg.fakeGraph, "urn:x-nmos:format:video")
	// failTo greift auch beim Rückschalten auf die alte Instanz; wir prüfen nur, dass sie versucht wird und nichts stoppt.
	if err := svc.MigrateInstanceSync(context.Background(), "old-1", "host-b"); err == nil {
		t.Fatal("want error")
	}
	l.mu.Lock()
	_, alive := l.byID["old-1"]
	l.mu.Unlock()
	if !alive {
		t.Fatal("old instance must keep running")
	}
	for _, id := range []string{"br-entry", "br-exit"} {
		l.mu.Lock()
		_, still := l.byID[id]
		l.mu.Unlock()
		if still {
			t.Fatalf("bridge member %s must be removed", id)
		}
	}
}

func TestDataTrackWithoutPathRejectsBeforeStart(t *testing.T) {
	fg := &fakeGraph{}
	svc, l, fb := setupBridged(t, fg, fg, "urn:x-nmos:format:data")
	err := svc.MigrateInstanceSync(context.Background(), "old-1", "host-b")
	if !errors.Is(err, ErrMXLPeer) || !errors.Is(err, hostbridge.ErrNoPath) {
		t.Fatalf("err = %v", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.pinsUsed) != 0 || len(fb.plans) != 0 {
		t.Fatal("nothing may start")
	}
}

func TestUnwrapOwnBridgesGivesDirectEdges(t *testing.T) {
	x := registry.NodeView{ID: "x", Senders: []registry.SenderView{{ID: "x-s"}}, Receivers: []registry.ReceiverView{{ID: "x-r"}}}
	groups := map[string]*bridgeGroup{
		"b1": {haveE: true, haveX: true, instances: []string{"e1", "x1"},
			entry: registry.NodeView{Receivers: []registry.ReceiverView{{ID: "b1-in"}}}, exit: registry.NodeView{Senders: []registry.SenderView{{ID: "b1-out"}}}},
		"b2": {haveE: true, haveX: true, instances: []string{"e2", "x2"},
			entry: registry.NodeView{Receivers: []registry.ReceiverView{{ID: "b2-in"}}}, exit: registry.NodeView{Senders: []registry.SenderView{{ID: "b2-out"}}}},
	}
	edges := []graph.Edge{
		{FromSender: "x-s", ToReceiver: "b1-in"}, {FromSender: "b1-out", ToReceiver: "viewer-r"}, // x sendet über b1
		{FromSender: "peer-s", ToReceiver: "b2-in"}, {FromSender: "b2-out", ToReceiver: "x-r"}, // x empfängt über b2
		{FromSender: "other-s", ToReceiver: "other-r"},
	}
	eff, old := unwrapBridges(edges, x, groups)
	want := map[graph.Edge]bool{
		{FromSender: "other-s", ToReceiver: "other-r"}: true,
		{FromSender: "x-s", ToReceiver: "viewer-r"}:    true,
		{FromSender: "peer-s", ToReceiver: "x-r"}:      true,
	}
	if len(eff) != 3 {
		t.Fatalf("eff = %v", eff)
	}
	for _, e := range eff {
		e.State = ""
		if !want[e] {
			t.Fatalf("unexpected edge %v in %v", e, eff)
		}
	}
	if len(old) != 4 {
		t.Fatalf("old bridges = %v", old)
	}
}

func TestPreviewReportsBridgesWithoutChangingAnything(t *testing.T) {
	fg := &fakeGraph{}
	svc, l, fb := setupBridged(t, fg, fg, "urn:x-nmos:format:video")
	p, err := svc.PreviewMigration(context.Background(), "old-1", "host-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Bridges) != 1 || p.Bridges[0].Transport != hostbridge.Fabrics || p.Bridges[0].FromHost != "host-b" || p.Bridges[0].ToHost != "host-a" ||
		len(p.Bridges[0].Peers) != 1 || p.Bridges[0].Peers[0] != "Viewer" || len(p.Bridges[0].Candidates) != 3 {
		t.Fatalf("preview = %+v", p)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.pinsUsed) != 0 || len(l.stopped) != 0 || len(fb.plans) != 0 || len(fg.calls) != 0 {
		t.Fatal("preview must not change anything")
	}
}

func TestPreviewWithoutBridgeIsEmptyAndReportsNoPath(t *testing.T) {
	fg := &fakeGraph{}
	svc, _, _ := setupBridged(t, fg, fg, "urn:x-nmos:format:video")
	if _, err := svc.PreviewMigration(context.Background(), "old-1", "host-a"); !errors.Is(err, ErrSameHost) {
		t.Fatalf("same host: %v", err)
	}
	fg2 := &fakeGraph{}
	svc2, _, _ := setupBridged(t, fg2, fg2, "urn:x-nmos:format:data")
	if _, err := svc2.PreviewMigration(context.Background(), "old-1", "host-b"); !errors.Is(err, hostbridge.ErrNoPath) {
		t.Fatalf("no path: %v", err)
	}
}

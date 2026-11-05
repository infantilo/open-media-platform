package workflows

import (
	"context"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func ifcDef(ifc *Interface) Definition {
	return Definition{
		Roles:     []Role{{Name: "mixer", NodeType: "omp-video-mixer-me"}, {Name: "src", NodeType: "omp-source"}},
		Interface: ifc,
	}
}

func TestValidateInterface(t *testing.T) {
	ok := &Interface{
		Outputs: []InterfacePort{{Name: "PGM", Members: []InterfaceMember{{Role: "mixer", Port: "PGM"}, {Role: "mixer", Port: "PGM Audio"}}}},
		Inputs:  []InterfacePort{{Name: "Zuspiel", Members: []InterfaceMember{{Role: "mixer"}}}},
	}
	if err := validate(ifcDef(ok)); err != nil {
		t.Fatalf("valid interface rejected: %v", err)
	}
	bad := map[string]*Interface{
		"leer":      {Outputs: []InterfacePort{{Name: " ", Members: []InterfaceMember{{Role: "mixer"}}}}},
		"doppelt":   {Outputs: []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "mixer"}}}, {Name: "A", Members: []InterfaceMember{{Role: "src"}}}}},
		"ohne":      {Outputs: []InterfacePort{{Name: "A"}}},
		"unbekannt": {Inputs: []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "gibtsnicht"}}}}},
	}
	for name, ifc := range bad {
		if err := validate(ifcDef(ifc)); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation", name, err)
		}
	}
	// gleicher Name auf Ausgangs- und Eingangsseite ist erlaubt
	both := &Interface{
		Outputs: []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "mixer"}}}},
		Inputs:  []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "mixer"}}}},
	}
	if err := validate(ifcDef(both)); err != nil {
		t.Errorf("same name on both sides rejected: %v", err)
	}
}

func TestResolveInterface(t *testing.T) {
	node := registry.NodeView{
		ID: "n1", Label: "Mixer", Online: true,
		Senders:   []registry.SenderView{{ID: "s-video", Label: "PGM", Format: "video"}, {ID: "s-audio", Label: "PGM Audio", Format: "audio"}},
		Receivers: []registry.ReceiverView{{ID: "r1", Label: "Input 1", Format: "video"}},
	}
	wf := Workflow{
		ID: "wf", Name: "Regie 1", Status: StatusStarted,
		Runtime: map[string]RoleRuntime{"mixer": {NodeID: "n1"}},
		Definition: ifcDef(&Interface{
			Outputs: []InterfacePort{
				{Name: "PGM", Label: "Programm", Members: []InterfaceMember{{Role: "mixer", Port: "PGM"}, {Role: "mixer", Port: "PGM Audio"}}},
				{Name: "Weg", Members: []InterfaceMember{{Role: "mixer", Port: "gibtsnicht"}}},
			},
			Inputs: []InterfacePort{{Name: "Zuspiel", Members: []InterfaceMember{{Role: "mixer", Port: "Input 1"}}}},
		}),
	}
	lookup := func(_ Workflow, role string) (registry.NodeView, bool) { return node, role == "mixer" }
	got := resolveInterface(wf, lookup)
	if len(got.Outputs) != 2 || !got.Outputs[0].Available || got.Outputs[0].Label != "Programm" {
		t.Fatalf("outputs = %+v", got.Outputs)
	}
	if m := got.Outputs[0].Members; m[0].PortID != "s-video" || m[1].PortID != "s-audio" || m[1].Format != "audio" {
		t.Errorf("members = %+v", m)
	}
	if got.Outputs[1].Available || got.Outputs[1].Label != "Weg" {
		t.Errorf("missing port must be unavailable, label falls back to name: %+v", got.Outputs[1])
	}
	if len(got.Inputs) != 1 || got.Inputs[0].Members[0].PortID != "r1" {
		t.Errorf("inputs = %+v", got.Inputs)
	}
	// gestoppt: kein Node → alles nicht verfügbar, Namen bleiben
	stopped := resolveInterface(wf, func(Workflow, string) (registry.NodeView, bool) { return registry.NodeView{}, false })
	if stopped.Outputs[0].Available || stopped.Inputs[0].Available || len(stopped.Outputs) != 2 {
		t.Errorf("stopped = %+v", stopped)
	}
	// ohne Interface: leere Listen, nicht null
	none := resolveInterface(Workflow{}, lookup)
	if none.Outputs == nil || none.Inputs == nil {
		t.Error("lists must be empty, not nil")
	}
}

func connectFixture(t *testing.T) (*Service, *fakeGraph, *fakeMethodInvoker) {
	t.Helper()
	store := newFakeStore()
	nodes := &fakeNodeLister{}
	nodes.add(registry.NodeView{ID: "ext", Label: "Ext", Online: true, Senders: []registry.SenderView{
		{ID: "x-video", Label: "Out", Format: formatVideo}, {ID: "x-audio", Label: "Out A", Format: "urn:x-nmos:format:audio"},
	}})
	nodes.add(registry.NodeView{ID: "mx", Label: "Mixer", Online: true, APIBaseURL: "http://mx"})
	nodes.add(registry.NodeView{ID: "vw", Label: "Viewer", Online: true, Receivers: []registry.ReceiverView{
		{ID: "r-video", Label: "Video in", Format: formatVideo}, {ID: "r-audio", Label: "Audio in", Format: "urn:x-nmos:format:audio"},
	}})
	g, m := &fakeGraph{}, &fakeMethodInvoker{}
	_ = store.Put(Workflow{
		ID: "wf", Name: "Regie", Status: StatusStarted,
		Runtime: map[string]RoleRuntime{"mixer": {NodeID: "mx"}, "viewer": {NodeID: "vw"}},
		Definition: Definition{
			Roles: []Role{{Name: "mixer", NodeType: "omp-video-mixer-me"}, {Name: "viewer", NodeType: "omp-viewer"}},
			Interface: &Interface{Inputs: []InterfacePort{
				{Name: "FQ1", Members: []InterfaceMember{{Role: "mixer"}}},
				{Name: "Mon", Members: []InterfaceMember{{Role: "viewer", Port: "Video in"}, {Role: "viewer", Port: "Audio in"}}},
			}},
		},
	})
	return &Service{store: store, nodes: nodes, graph: g, methods: m}, g, m
}

func TestConnectInputPinsOnCrosspointRole(t *testing.T) {
	s, g, m := connectFixture(t)
	res, err := s.ConnectInput(context.Background(), "wf", "FQ1", []string{"x-audio", "x-video"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Action != "pin" || res[0].SenderID != "x-video" {
		t.Fatalf("res = %+v", res)
	}
	if len(m.calls) != 1 || m.calls[0].method != "crosspoint.pin" || m.calls[0].args["senderId"] != "x-video" || len(g.calls) != 0 {
		t.Errorf("calls = %+v / %+v", m.calls, g.calls)
	}
}

func TestConnectInputConnectsReceiversByFormat(t *testing.T) {
	s, g, _ := connectFixture(t)
	if _, err := s.ConnectInput(context.Background(), "wf", "Mon", []string{"x-video", "x-audio"}, nil); err != nil {
		t.Fatal(err)
	}
	if len(g.calls) != 2 || g.calls[0] != (connectCall{"x-video", "r-video"}) || g.calls[1] != (connectCall{"x-audio", "r-audio"}) {
		t.Errorf("calls = %+v", g.calls)
	}
	// nur Bild: Ton-Mitglied scheitert, Bild-Mitglied gelingt → Gesamterfolg mit Fehler am Mitglied
	s2, g2, _ := connectFixture(t)
	res, err := s2.ConnectInput(context.Background(), "wf", "Mon", []string{"x-video"}, nil)
	if err != nil || len(g2.calls) != 1 || res[1].Error == "" {
		t.Errorf("err=%v calls=%+v res=%+v", err, g2.calls, res)
	}
}

func TestConnectInputErrors(t *testing.T) {
	s, _, _ := connectFixture(t)
	ctx := context.Background()
	if _, err := s.ConnectInput(ctx, "wf", "gibtsnicht", []string{"x-video"}, nil); !errors.Is(err, ErrValidation) {
		t.Errorf("unknown input: %v", err)
	}
	if _, err := s.ConnectInput(ctx, "wf", "FQ1", []string{"unbekannt"}, nil); !errors.Is(err, ErrValidation) {
		t.Errorf("unknown sender: %v", err)
	}
	if _, err := s.ConnectInput(ctx, "wf", "FQ1", []string{"x-audio"}, nil); !errors.Is(err, ErrValidation) {
		t.Errorf("audio only on crosspoint: %v", err)
	}
	wf, _ := s.store.Get("wf")
	wf.Status = StatusStopped
	_ = s.store.Put(wf)
	if _, err := s.ConnectInput(ctx, "wf", "FQ1", []string{"x-video"}, nil); !errors.Is(err, ErrNotRunning) {
		t.Errorf("stopped: %v", err)
	}
}

func TestFeedIsPersistedResolvedAndAppliedFromBothSides(t *testing.T) {
	s, g, m := connectFixture(t)
	nodes := s.nodes.(*fakeNodeLister)
	nodes.add(registry.NodeView{ID: "src", Label: "Src", Online: true, Senders: []registry.SenderView{{ID: "feed-video", Label: "PGM", Format: formatVideo}}})
	_ = s.store.Put(Workflow{
		ID: "up", Name: "Upstream", Status: StatusStarted,
		Runtime: map[string]RoleRuntime{"src": {NodeID: "src"}},
		Definition: Definition{
			Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
			Interface: &Interface{Outputs: []InterfacePort{{Name: "OUT", Members: []InterfaceMember{{Role: "src", Port: "PGM"}}}}},
		},
	})
	ctx := context.Background()
	feed := &InterfaceFeed{WorkflowID: "up", Output: "OUT"}
	if _, err := s.ConnectInput(ctx, "wf", "FQ1", []string{"feed-video"}, feed); err != nil {
		t.Fatal(err)
	}
	wf, _ := s.store.Get("wf")
	if got := wf.Definition.Interface.Inputs[0].Feed; got == nil || *got != *feed {
		t.Fatalf("feed not persisted: %+v", got)
	}
	res, err := s.ResolveInterface("wf")
	if err != nil || res.Inputs[0].Feed == nil || len(res.Inputs[0].FeedSenderIDs) != 1 || res.Inputs[0].FeedSenderIDs[0] != "feed-video" {
		t.Fatalf("resolved = %+v err=%v", res.Inputs[0], err)
	}
	// Start der Quelle (oder des Ziels): applyFeeds pinnt erneut, von beiden Seiten
	m.calls = nil
	s.applyFeeds(ctx, Workflow{ID: "up"})
	if len(m.calls) != 1 || m.calls[0].args["senderId"] != "feed-video" {
		t.Errorf("apply from source side: %+v", m.calls)
	}
	m.calls = nil
	s.applyFeeds(ctx, Workflow{ID: "wf"})
	if len(m.calls) != 1 {
		t.Errorf("apply from target side: %+v", m.calls)
	}
	// Quelle läuft nicht → nichts zu schalten, kein Fehler
	up, _ := s.store.Get("up")
	up.Status = StatusStopped
	_ = s.store.Put(up)
	m.calls = nil
	s.applyFeeds(ctx, Workflow{ID: "wf"})
	if len(m.calls) != 0 {
		t.Errorf("stopped source must not be applied: %+v", m.calls)
	}
	// Hand-Umschalten (ohne feed) hebt die Zuordnung auf
	up.Status = StatusStarted
	_ = s.store.Put(up)
	if _, err := s.ConnectInput(ctx, "wf", "FQ1", []string{"feed-video"}, nil); err != nil {
		t.Fatal(err)
	}
	wf, _ = s.store.Get("wf")
	if wf.Definition.Interface.Inputs[0].Feed != nil {
		t.Error("manual connect must clear the feed")
	}
	_ = g
}

func TestValidateRejectsBadFeed(t *testing.T) {
	bad := &Interface{Outputs: []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "mixer"}}, Feed: &InterfaceFeed{WorkflowID: "x", Output: "y"}}}}
	if err := validate(ifcDef(bad)); !errors.Is(err, ErrValidation) {
		t.Errorf("feed on output: %v", err)
	}
	bad2 := &Interface{Inputs: []InterfacePort{{Name: "A", Members: []InterfaceMember{{Role: "mixer"}}, Feed: &InterfaceFeed{WorkflowID: "x"}}}}
	if err := validate(ifcDef(bad2)); !errors.Is(err, ErrValidation) {
		t.Errorf("feed without output: %v", err)
	}
}

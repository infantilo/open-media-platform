package workflows

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"testing"
	"time"
)

// Kapitel 109 Stufe A: schon das erste Prozessende der Primärrolle löst die Übernahme aus.
func TestInstanceExitedPromotesStandbyOnFirstExit(t *testing.T) {
	t.Setenv("OMP_STANDBY_FIRST_EXIT", "")
	svc, _, _, _, wf, activeInstance, standbyInstance := setupRedundantWorkflow(t)

	svc.InstanceExited(activeInstance)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		after, _ := svc.Get(wf.ID)
		if after.Runtime["active"].InstanceID == standbyInstance {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("standby was not promoted after first exit")
}

func TestInstanceExitedSwitchOff(t *testing.T) {
	t.Setenv("OMP_STANDBY_FIRST_EXIT", "off")
	svc, _, _, _, wf, activeInstance, _ := setupRedundantWorkflow(t)

	svc.InstanceExited(activeInstance)
	time.Sleep(200 * time.Millisecond)

	after, _ := svc.Get(wf.ID)
	if after.Runtime["active"].InstanceID != activeInstance || after.Runtime["active"].StandbyActive {
		t.Fatalf("promotion happened although OMP_STANDBY_FIRST_EXIT=off: %+v", after.Runtime["active"])
	}
}

// Ein Prozessende einer Rolle OHNE Standby darf nichts übernehmen.
func TestInstanceExitedWithoutStandbyIsNoop(t *testing.T) {
	svc, _, g, _, _, _, _ := setupRedundantWorkflow(t)
	before := len(g.calls)
	svc.InstanceExited("unknown-instance")
	time.Sleep(100 * time.Millisecond)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != before {
		t.Fatalf("connect calls changed for unknown instance")
	}
}

// Live-Standby: Eingang beim Start gespiegelt, bei der Übernahme kein zusätzlicher Eingangs-Umbau nötig.
func TestLiveStandbyMirrorsInputAtStart(t *testing.T) {
	_, _, g, _, _, _, _ := setupRedundantWorkflowLive(t, true)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("calls = %+v, want 2", g.calls)
	}
	if g.calls[1].fromSender != "send-src" || g.calls[1].toReceiver != "recv-standby" {
		t.Errorf("mirrored call = %+v, want send-src -> recv-standby", g.calls[1])
	}
}

func TestConnectionsForTakeoverOrder(t *testing.T) {
	wf := Workflow{Definition: Definition{
		Roles: []Role{{Name: "p", NodeType: "x"}, {Name: "s", NodeType: "x", StandbyFor: "p", StandbyLive: true}},
		Connections: []Connection{
			{FromRole: "src", ToRole: "p"},
			{FromRole: "p", ToRole: "out"},
		},
	}}
	got := connectionsForTakeover(wf, "p", "s")
	if len(got) != 2 || got[0].FromRole != "p" {
		t.Fatalf("live order = %+v, want outputs first", got)
	}
	wf.Definition.Roles[1].StandbyLive = false
	got = connectionsForTakeover(wf, "p", "s")
	if len(got) != 2 || got[0].FromRole != "src" {
		t.Fatalf("cold order = %+v, want definition order", got)
	}
}

func TestValidateStandbyLiveNeedsStandbyFor(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	_, err := svc.Create("x", Definition{Roles: []Role{{Name: "a", NodeType: "omp-viewer", StandbyLive: true}}}, nil, "")
	if err == nil {
		t.Fatal("expected validation error")
	}
}

// Stufe B: ein ausdrücklich modellierter Ausgang des Standby (zum Redundanz-Umschalter) wird mit gespiegelt.
func TestMirrorStandbyWiresExplicitStandbyOutput(t *testing.T) {
	svc, nodes, g, _, wf, _, _ := setupRedundantWorkflowLive(t, true)
	nodes.add(registry.NodeView{ID: "node-sb2", InstanceID: "i-sb2", Senders: []registry.SenderView{{ID: "send-sb2"}}, Receivers: []registry.ReceiverView{{ID: "recv-sb2"}}})
	nodes.add(registry.NodeView{ID: "node-sink", InstanceID: "i-sink", Receivers: []registry.ReceiverView{{ID: "recv-sink"}}})
	wf.Definition.Roles = append(wf.Definition.Roles, Role{Name: "sink", NodeType: "omp-viewer"})
	wf.Definition.Connections = append(wf.Definition.Connections, Connection{FromRole: "standby", ToRole: "sink"})
	wf.Runtime["standby"] = RoleRuntime{InstanceID: "i-sb2", NodeID: "node-sb2"}
	wf.Runtime["sink"] = RoleRuntime{InstanceID: "i-sink", NodeID: "node-sink"}
	g.mu.Lock()
	g.calls = nil
	g.mu.Unlock()

	svc.mirrorStandbyInbound(wf, "active")

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("calls = %+v, want input mirror + standby output", g.calls)
	}
	if g.calls[0].fromSender != "send-src" || g.calls[0].toReceiver != "recv-sb2" {
		t.Errorf("input mirror = %+v", g.calls[0])
	}
	if g.calls[1].fromSender != "send-sb2" || g.calls[1].toReceiver != "recv-sink" {
		t.Errorf("standby output = %+v", g.calls[1])
	}
}

func TestWithStandbyRedundancyTagsPair(t *testing.T) {
	def := Definition{Roles: []Role{{Name: "p", NodeType: "x"}, {Name: "s", NodeType: "x", StandbyFor: "p"}, {Name: "o", NodeType: "x"}}}
	got := withStandbyRedundancy(def)
	if got.Roles[0].RedundancyGroup == "" || got.Roles[0].RedundancyGroup != got.Roles[1].RedundancyGroup {
		t.Fatalf("pair not tagged: %+v", got.Roles)
	}
	if got.Roles[2].RedundancyGroup != "" {
		t.Errorf("unrelated role tagged: %+v", got.Roles[2])
	}
	if def.Roles[0].RedundancyGroup != "" {
		t.Error("input definition must not be mutated")
	}
	// vorhandenes Tag wird übernommen, zwei verschiedene bleiben
	def.Roles[0].RedundancyGroup = "mix"
	if g := withStandbyRedundancy(def); g.Roles[1].RedundancyGroup != "mix" {
		t.Errorf("tag not inherited: %+v", g.Roles[1])
	}
	def.Roles[1].RedundancyGroup = "other"
	if g := withStandbyRedundancy(def); g.Roles[0].RedundancyGroup != "mix" || g.Roles[1].RedundancyGroup != "other" {
		t.Errorf("user tags changed: %+v", g.Roles)
	}
}

func TestRoleLinksDoNotBindStandby(t *testing.T) {
	def := Definition{
		Roles:       []Role{{Name: "p", NodeType: "a"}, {Name: "s", NodeType: "a", StandbyFor: "p"}, {Name: "sel", NodeType: "b"}},
		Connections: []Connection{{FromRole: "p", ToRole: "sel"}, {FromRole: "s", ToRole: "sel"}},
	}
	for _, l := range roleLinks(def, nil) {
		if (l.A == "s" || l.B == "s") && l.Bound {
			t.Errorf("link of standby must not bind: %+v", l)
		}
		if l.A == "p" && !l.Bound {
			t.Errorf("link of primary must still bind: %+v", l)
		}
	}
}

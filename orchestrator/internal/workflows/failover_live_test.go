package workflows

import (
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

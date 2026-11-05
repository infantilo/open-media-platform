package workflows

import (
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

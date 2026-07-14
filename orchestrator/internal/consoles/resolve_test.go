package consoles

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// fakeBindingLoader implementiert BindingLoader in-memory, damit diese
// Tests ohne echte Postgres-Verbindung laufen (authz.Store selbst wird
// gegen eine echte DB getestet, internal/authz/store_test.go).
type fakeBindingLoader struct {
	bindings []authz.Binding
}

func (f fakeBindingLoader) Load() ([]authz.Binding, error) {
	return f.bindings, nil
}

func TestResolveNoBindingsReturnsEmptyResult(t *testing.T) {
	resolver := NewResolver(fakeBindingLoader{})

	result, err := resolver.Resolve("anyone", nil)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.HasEngineeringAccess || len(result.Consoles) != 0 {
		t.Errorf("Resolve() = %+v, want empty result", result)
	}
}

func TestResolveOperateOnSpecificNode(t *testing.T) {
	resolver := NewResolver(fakeBindingLoader{bindings: []authz.Binding{
		{Subject: "operator1", NodeID: "inst-mixer", Verb: authz.VerbOperate},
	}})
	nodes := []NodeInfo{
		{ID: "node-uuid-1", Label: "Video Mixer M/E", InstanceID: "inst-mixer"},
		{ID: "node-uuid-2", Label: "Audio Mixer", InstanceID: "inst-audio"},
	}

	result, err := resolver.Resolve("operator1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.HasEngineeringAccess {
		t.Errorf("HasEngineeringAccess = true, want false (operate-only binding)")
	}
	if len(result.Consoles) != 1 {
		t.Fatalf("Consoles = %+v, want exactly 1 entry", result.Consoles)
	}
	got := result.Consoles[0]
	if got.NodeRoleID != "inst-mixer" || got.NodeLabel != "Video Mixer M/E" || got.UIBundleURL != "/api/v1/nodes/node-uuid-1" {
		t.Errorf("Consoles[0] = %+v, unexpected", got)
	}
	if got.WorkflowID != StubWorkflowID {
		t.Errorf("WorkflowID = %q, want %q", got.WorkflowID, StubWorkflowID)
	}
}

func TestResolveWildcardBindsAllNodes(t *testing.T) {
	resolver := NewResolver(fakeBindingLoader{bindings: []authz.Binding{
		{Subject: "operator1", NodeID: authz.AnyNode, Verb: authz.VerbOperate},
	}})
	nodes := []NodeInfo{
		{ID: "n1", Label: "B", InstanceID: "inst-b"},
		{ID: "n2", Label: "A", InstanceID: "inst-a"},
	}

	result, err := resolver.Resolve("operator1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if len(result.Consoles) != 2 {
		t.Fatalf("Consoles = %+v, want 2 entries", result.Consoles)
	}
	// Sortiert nach NodeLabel.
	if result.Consoles[0].NodeLabel != "A" || result.Consoles[1].NodeLabel != "B" {
		t.Errorf("Consoles = %+v, want sorted by label", result.Consoles)
	}
}

func TestResolveConfigureGrantsEngineeringAccessWithoutConsoleEntry(t *testing.T) {
	resolver := NewResolver(fakeBindingLoader{bindings: []authz.Binding{
		{Subject: "engineer1", NodeID: authz.AnyNode, Verb: authz.VerbConfigure},
	}})
	nodes := []NodeInfo{{ID: "n1", Label: "Mixer", InstanceID: "inst-mixer"}}

	result, err := resolver.Resolve("engineer1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if !result.HasEngineeringAccess {
		t.Errorf("HasEngineeringAccess = false, want true for configure binding")
	}
	if len(result.Consoles) != 0 {
		t.Errorf("Consoles = %+v, want empty (configure is not operate)", result.Consoles)
	}
}

func TestResolveIgnoresBindingsForOtherUsers(t *testing.T) {
	resolver := NewResolver(fakeBindingLoader{bindings: []authz.Binding{
		{Subject: "someone-else", NodeID: authz.AnyNode, Verb: authz.VerbOperate},
	}})
	nodes := []NodeInfo{{ID: "n1", Label: "Mixer", InstanceID: "inst-mixer"}}

	result, err := resolver.Resolve("operator1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if len(result.Consoles) != 0 {
		t.Errorf("Consoles = %+v, want empty", result.Consoles)
	}
}

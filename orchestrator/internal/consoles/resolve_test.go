package consoles

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeBindings(t *testing.T, bindings []Binding) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "role-bindings.json")
	data, err := json.Marshal(bindings)
	if err != nil {
		t.Fatalf("marshal bindings: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write bindings: %v", err)
	}
	return NewStore(path)
}

func TestResolveMissingFileReturnsEmptyResult(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "does-not-exist.json"))
	resolver := NewResolver(store)

	result, err := resolver.Resolve("anyone", nil)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.HasEngineeringAccess || len(result.Consoles) != 0 {
		t.Errorf("Resolve() = %+v, want empty result", result)
	}
}

func TestResolveOperateOnSpecificNode(t *testing.T) {
	store := writeBindings(t, []Binding{
		{UserID: "operator1", NodeID: "inst-mixer", Verb: VerbOperate},
	})
	resolver := NewResolver(store)
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
	store := writeBindings(t, []Binding{
		{UserID: "operator1", NodeID: "*", Verb: VerbOperate},
	})
	resolver := NewResolver(store)
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
	// Sortiert nach NodeLabel — "A" vor "B".
	if result.Consoles[0].NodeLabel != "A" || result.Consoles[1].NodeLabel != "B" {
		t.Errorf("Consoles not sorted by label: %+v", result.Consoles)
	}
}

func TestResolveConfigureGrantsEngineeringAccessWithoutConsoleEntry(t *testing.T) {
	store := writeBindings(t, []Binding{
		{UserID: "admin", NodeID: "*", Verb: VerbAdmin},
	})
	resolver := NewResolver(store)
	nodes := []NodeInfo{{ID: "n1", Label: "Switcher", InstanceID: "inst-1"}}

	result, err := resolver.Resolve("admin", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if !result.HasEngineeringAccess {
		t.Errorf("HasEngineeringAccess = false, want true for admin verb")
	}
	if len(result.Consoles) != 0 {
		t.Errorf("Consoles = %+v, want none (admin verb alone grants no operate console)", result.Consoles)
	}
}

func TestResolveFallsBackToRawNodeIDWithoutInstanceID(t *testing.T) {
	store := writeBindings(t, []Binding{
		{UserID: "operator1", NodeID: "raw-node-id", Verb: VerbOperate},
	})
	resolver := NewResolver(store)
	nodes := []NodeInfo{{ID: "raw-node-id", Label: "Manually started node"}}

	result, err := resolver.Resolve("operator1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if len(result.Consoles) != 1 || result.Consoles[0].NodeRoleID != "raw-node-id" {
		t.Errorf("Consoles = %+v, want NodeRoleID = raw-node-id", result.Consoles)
	}
}

func TestResolveIgnoresBindingsForOtherUsers(t *testing.T) {
	store := writeBindings(t, []Binding{
		{UserID: "someone-else", NodeID: "*", Verb: VerbOperate},
	})
	resolver := NewResolver(store)
	nodes := []NodeInfo{{ID: "n1", Label: "Switcher", InstanceID: "inst-1"}}

	result, err := resolver.Resolve("operator1", nodes)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.HasEngineeringAccess || len(result.Consoles) != 0 {
		t.Errorf("Resolve() = %+v, want empty result for unrelated user", result)
	}
}

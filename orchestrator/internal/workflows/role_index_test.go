package workflows

import (
	"testing"
	"time"
)

func TestFindRoleUsesIndexAndInvalidatesOnWrite(t *testing.T) {
	s := NewStore(testDB(t))
	svc := &Service{store: s}
	wf := Workflow{ID: "wfidx", Name: "idx", Status: StatusStarted, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		Runtime: map[string]RoleRuntime{"mixer": {InstanceID: "inst-1", NodeID: "node-1"}}}
	if err := s.Put(wf); err != nil {
		t.Fatal(err)
	}
	if id, _, role, ok := svc.FindRoleForNode("node-1"); !ok || id != "wfidx" || role != "mixer" {
		t.Fatalf("FindRoleForNode = %q %q %v", id, role, ok)
	}
	if _, _, ok := svc.FindRoleForInstance("inst-1"); !ok {
		t.Fatal("FindRoleForInstance should find inst-1")
	}
	wf.Runtime["mixer"] = RoleRuntime{InstanceID: "inst-2", NodeID: "node-2"}
	if err := s.UpdateRuntime(wf); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := svc.FindRoleForNode("node-1"); ok {
		t.Fatal("stale node-1 must be gone right after UpdateRuntime")
	}
	if _, _, _, ok := svc.FindRoleForNode("node-2"); !ok {
		t.Fatal("node-2 must be found")
	}
	if err := s.Delete("wfidx"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := svc.FindRoleForNode("node-2"); ok {
		t.Fatal("deleted workflow must vanish from index")
	}
}

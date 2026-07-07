package registry

import "testing"

func TestStoreListReturnsEmptySliceInitially(t *testing.T) {
	s := NewStore()
	got := s.List()
	if got == nil || len(got) != 0 {
		t.Errorf("List() = %v, want empty non-nil slice", got)
	}
}

func TestStoreSetAndList(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{{ID: "node-1", Label: "Node 1"}})

	got := s.List()
	if len(got) != 1 || got[0].ID != "node-1" {
		t.Errorf("List() = %+v, want one node-1", got)
	}
}

func TestStoreListReturnsCopyNotSharedSlice(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{{ID: "node-1"}})

	got := s.List()
	got[0].ID = "mutated"

	got2 := s.List()
	if got2[0].ID != "node-1" {
		t.Errorf("internal state was mutated via List() result: %+v", got2)
	}
}

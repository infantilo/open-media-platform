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

func TestStoreGetFindsByID(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{{ID: "node-1", Label: "Node 1"}, {ID: "node-2", Label: "Node 2"}})

	got, ok := s.Get("node-2")
	if !ok || got.Label != "Node 2" {
		t.Errorf("Get(node-2) = %+v, %v; want Node 2, true", got, ok)
	}
}

func TestStoreGetUnknownIDReturnsFalse(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{{ID: "node-1"}})

	_, ok := s.Get("does-not-exist")
	if ok {
		t.Error("Get(unknown) ok = true, want false")
	}
}

func TestStoreGetByInstanceIDFindsByInstanceTag(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{
		{ID: "node-1", InstanceID: "inst-a"},
		{ID: "node-2", InstanceID: "inst-b"},
		{ID: "node-3"}, // kein Instanz-Tag
	})

	got, ok := s.GetByInstanceID("inst-b")
	if !ok || got.ID != "node-2" {
		t.Errorf("GetByInstanceID(inst-b) = %+v, %v; want node-2, true", got, ok)
	}
}

func TestStoreGetByInstanceIDUnknownOrEmptyReturnsFalse(t *testing.T) {
	s := NewStore()
	s.Set([]NodeView{{ID: "node-1", InstanceID: "inst-a"}, {ID: "node-2"}})

	if _, ok := s.GetByInstanceID("does-not-exist"); ok {
		t.Error("GetByInstanceID(unknown) ok = true, want false")
	}
	if _, ok := s.GetByInstanceID(""); ok {
		t.Error("GetByInstanceID(\"\") ok = true, want false (an empty instance tag must never match a node without one)")
	}
}

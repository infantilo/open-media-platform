package snapshots

import (
	"testing"
	"time"
)

func TestGetUnknownIDReturnsNotFound(t *testing.T) {
	s := NewStore(t.TempDir())
	_, err := s.Get("does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestPutThenGetRoundTrips(t *testing.T) {
	s := NewStore(t.TempDir())
	snap := Snapshot{ID: "s1", Label: "Szene 1", Edges: []Edge{{FromSender: "a", ToReceiver: "b"}}}

	if err := s.Put(snap); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	got, err := s.Get("s1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Label != "Szene 1" || len(got.Edges) != 1 {
		t.Errorf("Get() = %+v, want roundtripped snapshot", got)
	}
}

func TestListReturnsEmptySliceInitially(t *testing.T) {
	s := NewStore(t.TempDir())
	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Errorf("List() = %v, want empty non-nil slice", list)
	}
}

func TestListOrdersByCreatedAt(t *testing.T) {
	s := NewStore(t.TempDir())
	now := time.Now()
	_ = s.Put(Snapshot{ID: "later", CreatedAt: now.Add(time.Minute)})
	_ = s.Put(Snapshot{ID: "earlier", CreatedAt: now})

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 2 || list[0].ID != "earlier" || list[1].ID != "later" {
		t.Fatalf("List() = %+v, want [earlier, later]", list)
	}
}

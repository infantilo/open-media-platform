package health

import (
	"testing"
	"time"
)

func TestUnknownNodeIsNotStale(t *testing.T) {
	tr := NewTracker()
	if tr.IsStale("node-1", time.Second) {
		t.Error("IsStale(never touched) = true, want false")
	}
}

func TestFreshTouchIsNotStale(t *testing.T) {
	tr := NewTracker()
	now := time.Now()
	tr.Touch("node-1")
	if tr.isStaleAt("node-1", 10*time.Second, now.Add(2*time.Second)) {
		t.Error("IsStale(2s after touch, 10s threshold) = true, want false")
	}
}

func TestOldTouchIsStale(t *testing.T) {
	tr := NewTracker()
	now := time.Now()
	tr.Touch("node-1")
	if !tr.isStaleAt("node-1", 10*time.Second, now.Add(11*time.Second)) {
		t.Error("IsStale(11s after touch, 10s threshold) = false, want true")
	}
}

func TestTouchResetsStaleness(t *testing.T) {
	tr := NewTracker()
	now := time.Now()
	tr.Touch("node-1")
	if !tr.isStaleAt("node-1", 10*time.Second, now.Add(11*time.Second)) {
		t.Fatal("expected stale before re-touch")
	}
	tr.Touch("node-1")
	if tr.IsStale("node-1", 10*time.Second) {
		t.Error("IsStale immediately after re-touch = true, want false")
	}
}

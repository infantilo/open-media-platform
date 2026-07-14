package hosts

import "testing"

func TestTrackerTouchAndGet(t *testing.T) {
	tracker := NewTracker()

	if _, ok := tracker.Get("host-1"); ok {
		t.Fatalf("Get() before any Touch() should return ok=false")
	}

	ok := tracker.Touch("host-1", []byte(`{"cpuPercent":42.5,"memUsedBytes":1000,"memTotalBytes":4000}`))
	if !ok {
		t.Fatalf("Touch() = false, want true for valid JSON")
	}

	m, ok := tracker.Get("host-1")
	if !ok {
		t.Fatalf("Get() ok = false after Touch()")
	}
	if m.CPUPercent != 42.5 || m.MemUsedBytes != 1000 || m.MemTotalBytes != 4000 {
		t.Errorf("Get() = %+v, unexpected", m)
	}
	if m.ReceivedAt.IsZero() {
		t.Errorf("ReceivedAt not set")
	}
}

func TestTrackerTouchInvalidPayload(t *testing.T) {
	tracker := NewTracker()
	ok := tracker.Touch("host-1", []byte(`not json`))
	if ok {
		t.Fatalf("Touch() = true, want false for invalid JSON")
	}
	if _, ok := tracker.Get("host-1"); ok {
		t.Fatalf("Get() ok = true, want false after a failed Touch()")
	}
}

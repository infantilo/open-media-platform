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

func TestTrackerKeepsGoodbyeFlag(t *testing.T) {
	tr := NewTracker()
	if !tr.Touch("h1", []byte(`{"goodbye":true}`)) {
		t.Fatal("Touch rejected goodbye payload")
	}
	if m, ok := tr.Get("h1"); !ok || !m.Goodbye {
		t.Fatalf("Goodbye not kept: %+v ok=%v", m, ok)
	}
	tr.Touch("h1", []byte(`{"cpuPercent":1}`))
	if m, _ := tr.Get("h1"); m.Goodbye {
		t.Fatal("Goodbye must clear once the host reports again")
	}
}

func TestClockMetricsProblem(t *testing.T) {
	cases := map[string]*ClockMetrics{
		"":             {Synced: true, TAIOffsetS: 37},
		"tai":          {Synced: true, TAIOffsetS: 0},
		"unsynced":     {Synced: false, TAIOffsetS: 37},
		"unsynced+tai": {Synced: false, TAIOffsetS: 0},
	}
	for want, c := range cases {
		if got := c.Problem(); got != want {
			t.Errorf("%+v: %q, want %q", c, got, want)
		}
	}
	var none *ClockMetrics
	if none.Problem() != "" {
		t.Error("ältere Agents ohne Uhrdaten: kein Befund")
	}
}

func TestTrackerKeepsClockFromTelemetry(t *testing.T) {
	tr := NewTracker()
	tr.Touch("h1", []byte(`{"cpuPercent":1,"clock":{"synced":false,"maxErrorUs":505,"estErrorUs":0,"taiOffsetS":0}}`))
	m, ok := tr.Get("h1")
	if !ok || m.Clock == nil || m.Clock.Synced || m.Clock.Problem() != "unsynced+tai" {
		t.Fatalf("%+v %v", m, ok)
	}
}

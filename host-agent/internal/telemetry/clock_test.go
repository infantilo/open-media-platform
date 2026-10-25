package telemetry

import "testing"

func TestClockFromKernelState(t *testing.T) {
	if c := clockFrom(0, 0, 120, 30, 37); !c.Synced || c.TAIOffsetS != 37 || c.MaxErrorUs != 120 || c.EstErrorUs != 30 {
		t.Fatalf("%+v", c)
	}
	if c := clockFrom(timeError, 0, 0, 0, 37); c.Synced {
		t.Fatal("TIME_ERROR = nicht synchron")
	}
	if c := clockFrom(0, staUnsync, 0, 0, 37); c.Synced {
		t.Fatal("STA_UNSYNC = nicht synchron")
	}
}

func TestTakeClockReadsTheRealKernelWithoutChangingIt(t *testing.T) {
	c, ok := TakeClock()
	if !ok {
		t.Skip("adjtimex nicht verfügbar")
	}
	t.Logf("synced=%v maxErr=%dus estErr=%dus tai=%d", c.Synced, c.MaxErrorUs, c.EstErrorUs, c.TAIOffsetS)
	if c.TAIOffsetS < 0 || c.TAIOffsetS > 100 {
		t.Fatalf("unplausibler TAI-Versatz %d", c.TAIOffsetS)
	}
}

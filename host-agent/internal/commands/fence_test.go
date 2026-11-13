package commands

import (
	"testing"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

// TestStartRejectsConcurrentStartOfSameInstance — ein zweites Start-Kommando für dieselbe ID, während das erste noch
// läuft, darf keinen zweiten Prozess erzeugen.
func TestStartRejectsConcurrentStartOfSameInstance(t *testing.T) {
	e := NewExecutor([]catalog.Entry{{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}}}, "", "", "", "host-1", nil)
	e.mu.Lock()
	e.starting = map[string]bool{"dup-1": true}
	e.mu.Unlock()
	if resp := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: "dup-1"}); resp.OK {
		t.Fatalf("second start while the first is in progress succeeded: %+v", resp)
	}
	if n := len(e.Instances()); n != 0 {
		t.Fatalf("instances after rejected start = %d, want 0", n)
	}
}

// TestStopAllStopsEveryInstance — Selbst-Abgrenzung: alle Instanzen enden, ohne als Absturz zu gelten.
func TestStopAllStopsEveryInstance(t *testing.T) {
	e := NewExecutor([]catalog.Entry{{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}}}, "", "", "", "host-1", nil)
	for _, id := range []string{"fence-a", "fence-b"} {
		if resp := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: id}); !resp.OK {
			t.Fatalf("start %s: %s", id, resp.Error)
		}
	}
	if n := e.StopAll(); n != 2 {
		t.Fatalf("StopAll() = %d, want 2", n)
	}
	if n := len(e.Instances()); n != 0 {
		t.Fatalf("instances after StopAll = %d, want 0", n)
	}
}

// TestKillEndsInstanceWithoutMarkingItStopped — "kill" beendet hart; das Ende zählt als Absturz (nicht als Stop).
func TestKillEndsInstanceWithoutMarkingItStopped(t *testing.T) {
	e := NewExecutor([]catalog.Entry{{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}}}, "", "", "", "host-1", nil)
	if resp := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: "kill-1"}); !resp.OK {
		t.Fatalf("start: %s", resp.Error)
	}
	if resp := e.Handle(Request{Action: "kill", InstanceID: "kill-1"}); !resp.OK {
		t.Fatalf("kill: %s", resp.Error)
	}
	e.mu.Lock()
	marked := e.stopping["kill-1"]
	e.mu.Unlock()
	if marked {
		t.Fatalf("kill marked the instance as stopping — its end would not be reported as a crash")
	}
	if resp := e.Handle(Request{Action: "kill", InstanceID: "nope"}); resp.OK {
		t.Fatalf("kill of an unknown instance must fail")
	}
}

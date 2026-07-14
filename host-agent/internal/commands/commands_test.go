package commands

import (
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

func TestHandleUnknownAction(t *testing.T) {
	e := NewExecutor(nil, "", "")
	resp := e.Handle(Request{Action: "explode"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false for unknown action", resp)
	}
}

func TestStartUnknownType(t *testing.T) {
	e := NewExecutor(nil, "", "")
	resp := e.Handle(Request{Action: "start", Type: "does-not-exist", InstanceID: "i1"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false for unknown catalog type", resp)
	}
}

func TestStartMissingInstanceID(t *testing.T) {
	e := NewExecutor([]catalog.Entry{{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}}}, "", "")
	resp := e.Handle(Request{Action: "start", Type: "sleeper"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false without instanceId", resp)
	}
}

func TestStartAndStopRealProcess(t *testing.T) {
	e := NewExecutor([]catalog.Entry{
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "30"}},
	}, "http://localhost:8010", "nats://localhost:4222")

	startResp := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: "test-1", Label: "Sleeper"})
	if !startResp.OK || startResp.PID == 0 {
		t.Fatalf("start Handle() = %+v, want OK with a PID", startResp)
	}
	if !processAlive(startResp.PID) {
		t.Fatalf("process %d not alive right after start", startResp.PID)
	}

	stopResp := e.Handle(Request{Action: "stop", InstanceID: "test-1"})
	if !stopResp.OK {
		t.Fatalf("stop Handle() = %+v, want OK", stopResp)
	}
	time.Sleep(200 * time.Millisecond)
	if processAlive(startResp.PID) {
		t.Fatalf("process %d still alive after stop", startResp.PID)
	}
}

func TestStopUnknownInstanceIsIdempotent(t *testing.T) {
	e := NewExecutor(nil, "", "")
	resp := e.Handle(Request{Action: "stop", InstanceID: "does-not-exist"})
	if !resp.OK {
		t.Fatalf("stop Handle() = %+v, want OK=true (idempotent) for unknown instance", resp)
	}
}

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

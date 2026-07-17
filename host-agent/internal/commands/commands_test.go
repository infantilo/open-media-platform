package commands

import (
	"encoding/json"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

// fakePublisher ist ein Test-Double für Publisher, das veröffentlichte
// ExitEvents sammelt statt eine echte NATS-Verbindung zu brauchen.
type fakePublisher struct {
	mu      sync.Mutex
	subject []string
	data    [][]byte
}

func (f *fakePublisher) Publish(subject string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subject = append(f.subject, subject)
	f.data = append(f.data, data)
	return nil
}

func (f *fakePublisher) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subject)
}

func (f *fakePublisher) last() (subject string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.subject)
	if n == 0 {
		return "", nil
	}
	return f.subject[n-1], f.data[n-1]
}

func TestHandleUnknownAction(t *testing.T) {
	e := NewExecutor(nil, "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "explode"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false for unknown action", resp)
	}
}

func TestStartUnknownType(t *testing.T) {
	e := NewExecutor(nil, "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "start", Type: "does-not-exist", InstanceID: "i1"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false for unknown catalog type", resp)
	}
}

func TestStartMissingInstanceID(t *testing.T) {
	e := NewExecutor([]catalog.Entry{{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}}}, "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "start", Type: "sleeper"})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false without instanceId", resp)
	}
}

func TestStartAndStopRealProcess(t *testing.T) {
	e := NewExecutor([]catalog.Entry{
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "30"}},
	}, "http://localhost:8010", "nats://localhost:4222", "host-1", nil)

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
	e := NewExecutor(nil, "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "stop", InstanceID: "does-not-exist"})
	if !resp.OK {
		t.Fatalf("stop Handle() = %+v, want OK=true (idempotent) for unknown instance", resp)
	}
}

// TestStartRejectsNonAllowlistedExtraEnvKey ist der im S2-Review
// (S3-Verifikationsplan) explizit verlangte Test: eine nicht gelistete
// Env-Var wird vom Agent abgelehnt, statt sie klaglos durchzureichen.
func TestStartRejectsNonAllowlistedExtraEnvKey(t *testing.T) {
	e := NewExecutor([]catalog.Entry{
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}},
	}, "", "", "host-1", nil)

	resp := e.Handle(Request{
		Action:     "start",
		Type:       "sleeper",
		InstanceID: "test-reject",
		ExtraEnv:   map[string]string{"OMP_EVIL": "rm -rf /"},
	})
	if resp.OK {
		t.Fatalf("Handle() = %+v, want OK=false for non-allowlisted extraEnv key", resp)
	}
}

// TestStartAllowsAllowlistedExtraEnvKeys — die Kapitel-15-Werte müssen
// weiterhin durchgereicht werden.
func TestStartAllowsAllowlistedExtraEnvKeys(t *testing.T) {
	e := NewExecutor([]catalog.Entry{
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "5"}},
	}, "", "", "host-1", nil)

	resp := e.Handle(Request{
		Action:     "start",
		Type:       "sleeper",
		InstanceID: "test-allow",
		ExtraEnv:   map[string]string{"OMP_WIDTH": "1280", "OMP_HEIGHT": "720"},
	})
	if !resp.OK {
		t.Fatalf("Handle() = %+v, want OK=true for allowlisted extraEnv keys", resp)
	}
	e.Handle(Request{Action: "stop", InstanceID: "test-allow"})
}

// TestUnexpectedExitPublishesExitEvent — S3-Kernverhalten: ein Prozess,
// der von selbst (nicht per stop()) endet, muss ein ExitEvent auf
// omp.host.<hostId>.events auslösen.
func TestUnexpectedExitPublishesExitEvent(t *testing.T) {
	pub := &fakePublisher{}
	e := NewExecutor([]catalog.Entry{
		{Type: "quick-exit", Runner: catalog.RunnerProcess, Command: []string{"sh", "-c", "exit 3"}},
	}, "", "", "host-42", pub)

	resp := e.Handle(Request{Action: "start", Type: "quick-exit", InstanceID: "test-crash"})
	if !resp.OK {
		t.Fatalf("start Handle() = %+v, want OK", resp)
	}

	deadline := time.Now().Add(2 * time.Second)
	for pub.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	if pub.count() != 1 {
		t.Fatalf("publish count = %d, want 1", pub.count())
	}
	subject, data := pub.last()
	if subject != "omp.host.host-42.events" {
		t.Errorf("subject = %q, want omp.host.host-42.events", subject)
	}
	var ev ExitEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if ev.InstanceID != "test-crash" || ev.ExitCode != 3 {
		t.Errorf("event = %+v, want instanceId=test-crash exitCode=3", ev)
	}
}

// TestExpectedStopDoesNotPublishExitEvent — ein per stop() beendeter
// Prozess ist kein Absturz, darf also kein ExitEvent auslösen (der
// Orchestrator weiß es schon, er hat den Stop selbst ausgelöst).
func TestExpectedStopDoesNotPublishExitEvent(t *testing.T) {
	pub := &fakePublisher{}
	e := NewExecutor([]catalog.Entry{
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "30"}},
	}, "", "", "host-42", pub)

	startResp := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: "test-stop"})
	if !startResp.OK {
		t.Fatalf("start Handle() = %+v, want OK", startResp)
	}
	stopResp := e.Handle(Request{Action: "stop", InstanceID: "test-stop"})
	if !stopResp.OK {
		t.Fatalf("stop Handle() = %+v, want OK", stopResp)
	}

	time.Sleep(300 * time.Millisecond)
	if pub.count() != 0 {
		t.Errorf("publish count = %d after expected stop, want 0", pub.count())
	}
}

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

package launcher

import (
	"errors"
	"testing"
	"time"
)

// TestKickRestartsInstanceThroughSupervision — Kick beendet den Prozess hart; die Überwachung behandelt das wie einen
// Absturz und startet die Instanz unter derselben ID neu.
func TestKickRestartsInstanceThroughSupervision(t *testing.T) {
	backoff := crashRestartBackoff
	crashRestartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { crashRestartBackoff = backoff })

	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil, nil)
	inst, err := l.Start("sleepy", "", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() { _ = l.Stop(inst.ID) }()

	if err := l.Kick(inst.ID); err != nil {
		t.Fatalf("Kick() error = %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	var got Instance
	for time.Now().Before(deadline) {
		got, _ = l.Get(inst.ID)
		if got.PID != inst.PID && got.RestartCount == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got.PID == inst.PID || got.RestartCount != 1 || got.Crashed || !processAlive(got.PID) {
		t.Fatalf("instance after Kick = %+v, want restarted once under a new pid", got)
	}
	if err := l.Kick("does-not-exist"); !errors.Is(err, ErrUnknownInstance) {
		t.Fatalf("Kick(unknown) error = %v, want ErrUnknownInstance", err)
	}
}

package playout

import "testing"

func TestChannelTransitions(t *testing.T) {
	ok := [][2]string{
		{ChannelStopped, ChannelStarting}, {ChannelStarting, ChannelRunning},
		{ChannelRunning, ChannelHold}, {ChannelHold, ChannelRunning},
		{ChannelRunning, ChannelLiveAssist}, {ChannelRunning, ChannelStopping},
		{ChannelStopping, ChannelStopped}, {ChannelRunning, ChannelError},
		{ChannelError, ChannelStarting},
	}
	for _, p := range ok {
		if err := ChannelTransitions.Validate(p[0], p[1]); err != nil {
			t.Errorf("%s -> %s should be allowed: %v", p[0], p[1], err)
		}
	}
	bad := [][2]string{
		{ChannelStopped, ChannelRunning}, // ohne STARTING
		{ChannelStopped, ChannelHold},
		{ChannelError, ChannelRunning}, // Fehler nicht stillschweigend verlassen
		{ChannelStopping, ChannelRunning},
	}
	for _, p := range bad {
		if ChannelTransitions.Allowed(p[0], p[1]) {
			t.Errorf("%s -> %s must be rejected", p[0], p[1])
		}
	}
}

func TestEventTransitions(t *testing.T) {
	path := []string{EventPlanned, EventPreflight, EventReady, EventTaking, EventOnAir, EventCompleting, EventCompleted}
	for i := 0; i+1 < len(path); i++ {
		if err := EventTransitions.Validate(path[i], path[i+1]); err != nil {
			t.Errorf("%s -> %s: %v", path[i], path[i+1], err)
		}
	}
	// Endzustände haben keine Ausgänge.
	for _, end := range []string{EventCompleted, EventFailed, EventSkipped} {
		for _, to := range []string{EventPlanned, EventOnAir, EventCompleted} {
			if EventTransitions.Allowed(end, to) {
				t.Errorf("%s is terminal but %s -> %s allowed", end, end, to)
			}
		}
	}
	// Nicht auf Sendung ohne Take-Phase.
	if EventTransitions.Allowed(EventReady, EventOnAir) || EventTransitions.Allowed(EventPlanned, EventOnAir) {
		t.Error("ON_AIR must only be reachable via TAKING")
	}
}

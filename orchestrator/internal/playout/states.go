package playout

import "github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"

// Channel-Zustände (Spec §196).
const (
	ChannelStopped    = "STOPPED"
	ChannelStarting   = "STARTING"
	ChannelRunning    = "RUNNING"
	ChannelHold       = "HOLD"
	ChannelLiveAssist = "LIVE_ASSIST"
	ChannelStopping   = "STOPPING"
	ChannelError      = "ERROR"
)

// ChannelTransitions: erlaubte Channel-Zustandsübergänge. ERROR ist aus
// jedem aktiven Zustand erreichbar und nur über STOPPED/STARTING wieder
// verlassbar (kein stilles Weiterlaufen nach einem Fehler).
var ChannelTransitions = statemachine.New([][2]string{
	{ChannelStopped, ChannelStarting},
	{ChannelStarting, ChannelRunning},
	{ChannelStarting, ChannelError},
	{ChannelStarting, ChannelStopping},
	{ChannelRunning, ChannelHold},
	{ChannelHold, ChannelRunning},
	{ChannelRunning, ChannelLiveAssist},
	{ChannelLiveAssist, ChannelRunning},
	{ChannelHold, ChannelLiveAssist},
	{ChannelLiveAssist, ChannelHold},
	{ChannelRunning, ChannelStopping},
	{ChannelHold, ChannelStopping},
	{ChannelLiveAssist, ChannelStopping},
	{ChannelStopping, ChannelStopped},
	{ChannelRunning, ChannelError},
	{ChannelHold, ChannelError},
	{ChannelLiveAssist, ChannelError},
	{ChannelStopping, ChannelError},
	{ChannelError, ChannelStopping},
	{ChannelError, ChannelStopped},
	{ChannelError, ChannelStarting},
})

// Event-Zustände eines Playlist-Events (Spec §197).
const (
	EventPlanned    = "PLANNED"
	EventPreflight  = "PREFLIGHT"
	EventCued       = "CUED"
	EventReady      = "READY"
	EventTaking     = "TAKING"
	EventOnAir      = "ON_AIR"
	EventCompleting = "COMPLETING"
	EventCompleted  = "COMPLETED"
	EventFailed     = "FAILED"
	EventSkipped    = "SKIPPED"
)

// EventTransitions: Hauptpfad PLANNED → … → COMPLETED. FAILED und SKIPPED
// sind Endzustände; Preflight/Cue dürfen zurück auf PLANNED (Neuplanung
// nach Playlist-Änderung, Spec §167) und READY zurück auf PREFLIGHT, wenn
// eine Voraussetzung wegfällt (z. B. Quelle offline).
var EventTransitions = statemachine.New([][2]string{
	{EventPlanned, EventPreflight},
	{EventPlanned, EventCued}, // direkter Cue ohne Preflight (Altbestand/manuell)
	{EventPlanned, EventSkipped},
	{EventPreflight, EventCued},
	{EventPreflight, EventReady},
	{EventPreflight, EventFailed},
	{EventPreflight, EventPlanned},
	{EventPreflight, EventSkipped},
	{EventCued, EventReady},
	{EventCued, EventTaking}, // Live-Assist: Take auf gecuten Event
	{EventCued, EventFailed},
	{EventCued, EventPlanned},
	{EventCued, EventSkipped},
	{EventReady, EventTaking},
	{EventReady, EventPreflight},
	{EventReady, EventFailed},
	{EventReady, EventSkipped},
	{EventTaking, EventOnAir},
	{EventTaking, EventFailed},
	{EventOnAir, EventCompleting},
	{EventOnAir, EventCompleted}, // Live ohne Ausblendphase
	{EventOnAir, EventFailed},
	{EventOnAir, EventSkipped}, // Operator-Skip des laufenden Events
	{EventCompleting, EventCompleted},
	{EventCompleting, EventFailed},
})

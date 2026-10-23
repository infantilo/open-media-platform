// Package jobrun verteilt ffmpeg-/ffprobe-Jobs auf Hosts (docs/ENTWURF-FFMPEG-HOSTWAHL.md): Ziel-Auswahl, automatische
// Zuweisung nach Last, Sendeschutz, Wiederholung bei Hostverlust. Aufrufer (script-Schritt, File-QC, Review-Proxy,
// Ingest-Convert) reichen einen [Spec] ein und bekommen ein [Result]; ob der Job lokal oder auf einem Host-Agent läuft,
// entscheidet der Dispatcher.
package jobrun

import (
	"fmt"
	"strings"
	"time"
)

// Class ist die Prioritätsklasse eines Jobs.
type Class string

const (
	// ClassInteractive: eine Person wartet (Review-Proxy, Assistent).
	ClassInteractive Class = "interactive"
	// ClassScheduled: hat einen Termin (Ingest-Nachbearbeitung vor Sendung).
	ClassScheduled Class = "scheduled"
	// ClassBatch: Hintergrundarbeit (File-QC, Workflow-Schritte).
	ClassBatch Class = "batch"
)

func (c Class) valid() bool { return c == ClassInteractive || c == ClassScheduled || c == ClassBatch }

// rank: kleiner = wichtiger.
func (c Class) rank() int {
	switch c {
	case ClassInteractive:
		return 0
	case ClassScheduled:
		return 1
	default:
		return 2
	}
}

// Spec beschreibt einen Job.
type Spec struct {
	// Caller: "script", "qc", "proxy", "convert", "assistant", … — Schlüssel für Standardziele.
	Caller string   `json:"caller"`
	Tool   string   `json:"tool"` // ffmpeg | ffprobe
	Args   []string `json:"args"`
	// Target: "" (Standard aus der Konfiguration), "auto", "local", "host:<id>", "pool:<name>".
	Target string `json:"target,omitempty"`
	Class  Class  `json:"class,omitempty"`
	Label  string `json:"label,omitempty"`
	// Inputs/Outputs: Pfade (aus Sicht des Orchestrators) für Sichtbarkeitsprüfung und Pfadumschreibung je Host.
	Inputs  []string `json:"inputs,omitempty"`
	Outputs []string `json:"outputs,omitempty"`
	// Atomic: Ausgaben werden als <name>.part.<ext> geschrieben und nach Erfolg umbenannt.
	Atomic   bool `json:"atomic,omitempty"`
	TimeoutS int  `json:"timeoutS,omitempty"`
	// EstimateS: geschätzte Laufzeit (Vorausschau gegen gebuchte Live-Zeit); 0 = Standard-Vorausschau.
	EstimateS int `json:"estimateS,omitempty"`
	// LiveInput: der Job liest eine laufende Quelle — kann nicht pausiert werden (Netzquelle läuft weiter).
	LiveInput bool `json:"liveInput,omitempty"`
	// OnStderr bekommt Zeilen (nur im Prozess, nicht serialisiert).
	OnStderr func(line string) `json:"-"`
}

// State ist der Zustand eines Jobs.
type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateDone      State = "done"
	StateFailed    State = "failed" // Ausführung nicht möglich
	StateCancelled State = "cancelled"
)

// Job ist der Datensatz eines Jobs.
type Job struct {
	ID       string     `json:"id"`
	Spec     Spec       `json:"spec"`
	State    State      `json:"state"`
	Host     string     `json:"host,omitempty"`
	Attempt  int        `json:"attempt"`
	Created  time.Time  `json:"created"`
	Started  *time.Time `json:"started,omitempty"`
	Finished *time.Time `json:"finished,omitempty"`
	ExitCode int        `json:"exitCode"`
	Error    string     `json:"error,omitempty"`
	Progress string     `json:"progress,omitempty"`
	Paused   bool       `json:"paused,omitempty"`
	Nice     int        `json:"nice,omitempty"`
	// Wait: warum der Job (noch) wartet.
	Wait string `json:"wait,omitempty"`
	// Placement: Begründung der letzten Auswahl (Kandidaten mit Score/Ablehnungsgrund).
	Placement *Decision `json:"placement,omitempty"`
	// Events: Eingriffe des Sendeschutzes und Wiederholungen.
	Events  []JobEvent `json:"events,omitempty"`
	Exclude []string   `json:"exclude,omitempty"`
}

// JobEvent protokolliert einen Eingriff.
type JobEvent struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"` // placed | retry | throttle | pause | resume | cancel | protect-cancel | wait
	Detail string    `json:"detail,omitempty"`
}

// Result ist das Ergebnis für den Aufrufer.
type Result struct {
	// ExitCode: Exit-Code des Programms (Ergebnis, kein Ausführungsfehler).
	ExitCode int
	Stdout   []byte
	Tail     []string
	Host     string
	// Err: Ausführung nicht möglich (nicht gefunden, abgebrochen, Zeitlimit, Host weg, Pfad nicht sichtbar).
	Err error
}

// Target ist ein geparstes Ziel.
type Target struct {
	Kind string // auto | local | host | pool
	Name string
}

// ParseTarget parst "auto", "local", "host:<id>", "pool:<name>".
func ParseTarget(s string) (Target, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "auto":
		return Target{Kind: "auto"}, nil
	case s == "local":
		return Target{Kind: "local"}, nil
	case strings.HasPrefix(s, "host:") && len(s) > 5:
		return Target{Kind: "host", Name: s[5:]}, nil
	case strings.HasPrefix(s, "pool:") && len(s) > 5:
		return Target{Kind: "pool", Name: s[5:]}, nil
	}
	return Target{}, fmt.Errorf("ungültiges Ziel %q (auto | local | host:<id> | pool:<name>)", s)
}

func (t Target) String() string {
	if t.Name != "" {
		return t.Kind + ":" + t.Name
	}
	return t.Kind
}

// LocalHostID ist die Host-ID des Orchestrator-Rechners selbst.
const LocalHostID = "local"

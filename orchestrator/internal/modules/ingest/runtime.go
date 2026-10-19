package ingest

import (
	"context"
	"errors"
)

// Runtime ist die Schnittstelle zur Laufzeit (Launcher, Registry, IS-05, Node-Methoden). Der Ablauf kennt nur diese Schnittstelle —
// Tests laufen gegen einen Simulator, der Betrieb gegen launcherRuntime (runtime_launcher.go).
//
// Alle Methoden müssen **idempotent** sein: nach einem Neustart des Orchestrators ruft der Ablauf sie für bereits laufende Aufträge
// erneut auf (Adopt statt Neustart).
type Runtime interface {
	// Prepare startet (oder übernimmt) den Rekorder für den Auftrag auf dem Host und wartet, bis er erreichbar ist.
	Prepare(ctx context.Context, jobID, hostID string, label string, mediaDir string) (Session, error)
	// Adopt prüft, ob die Instanz noch existiert und gesund ist.
	Adopt(ctx context.Context, instanceID string) (Session, bool)
	// ResolveSource prüft, ob die Quelle jetzt verfügbar ist (Instanz online, Sender vorhanden).
	ResolveSource(ctx context.Context, src Source) error
	// Connect verbindet die Quelle mit den Empfängern des Rekorders (IS-05).
	Connect(ctx context.Context, s Session, src Source) error
	StartRecording(ctx context.Context, s Session, fileRel string, mcaPlan string) error
	// Status: "idle" | "recording" | "error"; durationMs seit Aufnahmestart.
	Status(ctx context.Context, s Session) (status string, durationMs int64, err error)
	StopRecording(ctx context.Context, s Session) error
	// Teardown beendet die Instanz (idempotent: fehlende Instanz ist kein Fehler).
	Teardown(ctx context.Context, instanceID string) error
	// Instances listet vom Ingest gestartete Rekorder-Instanzen (Label-Präfix) — für die Suche nach verwaisten.
	Instances(ctx context.Context) []string
}

type Session struct {
	InstanceID string
	HostID     string
}

var (
	// ErrSourceUnavailable: Quelle (noch) nicht da — löst die Verspätungsrichtlinie aus, ist kein harter Fehler.
	ErrSourceUnavailable = errors.New("Quelle nicht verfügbar")
)

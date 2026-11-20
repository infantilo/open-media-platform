package ingest

import (
	"context"
	"errors"
	"time"
)

// Runtime ist die Schnittstelle zur Laufzeit (Launcher, Registry, IS-05, Node-Methoden). Der Ablauf kennt nur diese Schnittstelle —
// Tests laufen gegen einen Simulator, der Betrieb gegen launcherRuntime (runtime_launcher.go).
//
// Alle Methoden müssen **idempotent** sein: nach einem Neustart des Orchestrators ruft der Ablauf sie für bereits laufende Aufträge
// erneut auf (Adopt statt Neustart).
type Runtime interface {
	// Prepare startet (oder übernimmt) den Rekorder für den Auftrag auf dem Host und wartet, bis er erreichbar ist.
	// audioInputs: Anzahl der Audio-Eingänge des Rekorders (1 = nur Hauptquelle; mehr bei einem Kanalplan mit weiteren Quellen).
	Prepare(ctx context.Context, jobID, hostID string, label string, mediaDir string, audioInputs int) (Session, error)
	// Adopt prüft, ob die Instanz noch existiert und gesund ist.
	Adopt(ctx context.Context, instanceID string) (Session, bool)
	// ResolveSource prüft, ob die Quelle jetzt verfügbar ist (Instanz online, Sender vorhanden).
	ResolveSource(ctx context.Context, src Source) error
	// Connect verbindet die Quelle (Video + Audio) mit den Empfängern des Rekorders (IS-05); weitere Quellen eines Kanalplans (Audio) kommen auf
	// die weiteren Audio-Empfänger „Audio 2“ …
	Connect(ctx context.Context, s Session, src Source, audio *AudioPlan) error
	// StartRecording startet die Aufnahme; `audio` (Kanalplan) wird dem Rekorder vorher mitgegeben, nil = Ton der Hauptquelle unverändert.
	StartRecording(ctx context.Context, s Session, fileRel string, mcaPlan string, audio *AudioPlan) error
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

// ---- Ziel „TAMS“ (Kapitel 105.6) ------------------------------------------------------------------------------------------------

type targetKey struct{}

// WithTarget merkt das Aufnahmeziel des Profils im Kontext; die Laufzeit wählt danach den Node-Typ (omp-recorder oder omp-tams-writer).
func WithTarget(ctx context.Context, target string) context.Context {
	return context.WithValue(ctx, targetKey{}, target)
}

type tamsEnvKey struct{}

// WithTamsEnv gibt der Laufzeit zusätzliche Umgebung für den TAMS-Schreiber mit (Aufbewahrung des Profils).
func WithTamsEnv(ctx context.Context, env map[string]string) context.Context {
	return context.WithValue(ctx, tamsEnvKey{}, env)
}

func tamsEnvOf(ctx context.Context) map[string]string {
	m, _ := ctx.Value(tamsEnvKey{}).(map[string]string)
	return m
}

func targetOf(ctx context.Context) string {
	t, _ := ctx.Value(targetKey{}).(string)
	return t
}

// TamsFlowRef: eine Metadaten-Kopie (neuer Flow, gleiche Objects) einer Essenz.
type TamsFlowRef struct {
	SourceFlow string `json:"sourceFlow"`
	FlowID     string `json:"flowId"`
	SourceID   string `json:"sourceId"`
	Segments   int    `json:"segments"`
	From       string `json:"from"`
	To         string `json:"to"`
}

// TamsRef: Ergebnis einer Aufnahme in den Speicher — Verweise statt Datei.
type TamsRef struct {
	Video *TamsFlowRef `json:"video,omitempty"`
	Audio *TamsFlowRef `json:"audio,omitempty"`
}

// TamsRuntime ist die optionale Erweiterung der Laufzeit für Profile mit Ziel „tams“.
type TamsRuntime interface {
	// CopyRange wartet, bis der Schreiber alles registriert hat, und legt je Essenz der Quelle eine Metadaten-Kopie von [start, end) an.
	// Der Bereich wird auf ganze Segmente erweitert (siehe CONTRACT-TAMS.md). Muss vor Teardown laufen (die Zugangsdaten leben im Node).
	CopyRange(ctx context.Context, s Session, src Source, start, end time.Time, label string) (TamsRef, error)
}

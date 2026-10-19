package ingest

import (
	"encoding/json"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// Lebenszyklus eines Aufnahmeauftrags.
const (
	StScheduled  = "scheduled"             // zugelassen, Ressourcen reserviert, wartet auf den Start
	StBlocked    = "blocked"               // nicht zugelassen (Konflikt/Engpass) — mit Gründen, wird neu bewertet
	StWaiting    = "waiting_for_resources" // Zeit ist da, Quelle/Host/Rekorder noch nicht bereit
	StStarting   = "starting"              // Rekorder wird gestartet/verbunden (auch Vorwärmen)
	StRecording  = "recording"
	StFinalizing = "finalizing"
	StProcessing = "processing"
	StCompleted  = "completed"
	StFailed     = "failed"
	StCancelled  = "cancelled"
)

var Transitions = statemachine.New([][2]string{
	{StBlocked, StScheduled},
	{StBlocked, StCancelled},
	{StBlocked, StFailed},    // Startzeit verstrichen, nie zugelassen
	{StScheduled, StBlocked}, // Neubewertung nach Änderung
	{StScheduled, StStarting},
	{StScheduled, StWaiting},
	{StScheduled, StCancelled},
	{StScheduled, StFailed},
	{StWaiting, StStarting},
	{StWaiting, StFailed},
	{StWaiting, StCancelled},
	{StStarting, StRecording},
	{StStarting, StWaiting},
	{StStarting, StFailed},
	{StStarting, StCancelled},
	{StRecording, StFinalizing},
	{StRecording, StStarting}, // Wiederanlauf nach Abbruch (neuer Versuch, Rest der Zeit)
	{StRecording, StFailed},
	{StRecording, StCancelled}, // Bediener bricht ab: Teilaufnahme wird finalisiert
	{StFinalizing, StProcessing},
	{StFinalizing, StCompleted},
	{StFinalizing, StFailed},
	{StFinalizing, StCancelled}, // abgebrochen: Teilaufnahme wurde gesichert
	{StProcessing, StCompleted},
	{StProcessing, StFailed},
})

// Terminal: Auftrag ist beendet, Reservierungen freigegeben.
func Terminal(s string) bool { return s == StCompleted || s == StFailed || s == StCancelled }

// Active: Zustände mit laufender/vorbereiteter Instanz.
func Active(s string) bool {
	return s == StStarting || s == StRecording || s == StFinalizing || s == StProcessing
}

type Source struct {
	// InstanceID: stabile Launcher-Instanz-ID der Quelle (bevorzugt); SenderLabel wählt den Sender, leer = erster Video-/Audio-Sender.
	InstanceID  string `json:"instanceId,omitempty"`
	SenderLabel string `json:"senderLabel,omitempty"`
	// SenderID: direkter IS-04-Sender (ändert sich bei Node-Neustart; nur für Ad-hoc-Aufnahmen).
	SenderID string `json:"senderId,omitempty"`
	Label    string `json:"label,omitempty"`
}

// Key identifiziert die Quelle für Limits/Konflikte.
func (s Source) Key() string {
	switch {
	case s.InstanceID != "":
		return "inst:" + s.InstanceID + "/" + s.SenderLabel
	case s.SenderID != "":
		return "sender:" + s.SenderID
	}
	return "unknown"
}

type Storage struct {
	// Dir: Unterverzeichnis unter MediaDir; FileTemplate mit {name} {date} {time} {job}; leer = Standard.
	Dir          string `json:"dir,omitempty"`
	FileTemplate string `json:"fileTemplate,omitempty"`
}

// AudioChannel: ein Ausgabekanal der Aufnahmedatei. Input = Nummer der Audio-Quelle (0 = Hauptquelle, 1… = AudioPlan.Inputs), nil = Stille.
type AudioChannel struct {
	Input   *int    `json:"input"`
	Channel int     `json:"channel"`
	GainDb  float64 `json:"gainDb,omitempty"`
	Label   string  `json:"label,omitempty"`
}

// AudioPlan (Kapitel 45): Kanalzuordnung der Aufnahme — Kanäle mehrerer Quellen in beliebiger Reihenfolge („Shuffling“), mit Gain und Stille.
// Ohne Plan wird der Ton der Hauptquelle unverändert aufgenommen.
type AudioPlan struct {
	// Inputs: weitere Audio-Quellen (Eingang 1…); die Hauptquelle (Eingang 0) ist Schedule.Source.
	Inputs   []Source       `json:"inputs,omitempty"`
	Channels []AudioChannel `json:"channels"`
}

// ExtraKeys: Quellenschlüssel der weiteren Quellen (für Konflikte/Limits).
func (p *AudioPlan) ExtraKeys() []string {
	if p == nil {
		return nil
	}
	var out []string
	for _, s := range p.Inputs {
		out = append(out, s.Key())
	}
	return out
}

// RecorderJSON: Kanalplan im Format des Rekorders (`record.audioPlan`).
func (p *AudioPlan) RecorderJSON() string {
	if p == nil || len(p.Channels) == 0 {
		return ""
	}
	type ch struct {
		Input   *int    `json:"input"`
		Channel int     `json:"channel"`
		GainDb  float64 `json:"gainDb"`
	}
	out := struct {
		Channels []ch `json:"channels"`
	}{}
	for _, c := range p.Channels {
		out.Channels = append(out.Channels, ch{c.Input, c.Channel, c.GainDb})
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// Schedule: ein (ggf. wiederkehrender) Aufnahmezeitplan.
type Schedule struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Enabled   bool           `json:"enabled"`
	Revision  int            `json:"revision"`
	Source    Source         `json:"source"`
	Spec      Spec           `json:"spec"`
	ProfileID string         `json:"profileId"`
	Storage   Storage        `json:"storage"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	Priority  int            `json:"priority"`
	Retry     RetryPolicy    `json:"retry"`
	Late      LatePolicy     `json:"late"`
	HostPref  string         `json:"hostPref,omitempty"`
	// Audio: Kanalplan (Kapitel 45), nil = Ton der Hauptquelle unverändert.
	Audio *AudioPlan `json:"audio,omitempty"`
	// Owner/OwnerGroup: Verantwortliche Person bzw. Gruppe (Kapitel 44); Aufträge erben sie.
	Owner      string     `json:"owner,omitempty"`
	OwnerGroup string     `json:"ownerGroup,omitempty"`
	CreatedBy  string     `json:"createdBy,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	Cancelled  *time.Time `json:"cancelledAt,omitempty"`
}

// Job: ein konkretes Vorkommen.
type Job struct {
	ID            string          `json:"id"`
	ScheduleID    string          `json:"scheduleId,omitempty"`
	Key           string          `json:"idempotencyKey"`
	Name          string          `json:"name"`
	PlannedStart  time.Time       `json:"plannedStart"`
	PlannedEnd    time.Time       `json:"plannedEnd"`
	TZ            string          `json:"tz"`
	Shifted       bool            `json:"shifted,omitempty"`
	Ambiguous     bool            `json:"ambiguous,omitempty"`
	State         string          `json:"state"`
	StateSince    time.Time       `json:"stateSince"`
	Attempt       int             `json:"attempt"`
	MaxAttempts   int             `json:"maxAttempts"`
	Priority      int             `json:"priority"`
	Source        Source          `json:"source"`
	ProfileID     string          `json:"profileId"`
	HostPref      string          `json:"hostPref,omitempty"`
	HostID        string          `json:"hostId,omitempty"`
	InstanceID    string          `json:"instanceId,omitempty"`
	FileRel       string          `json:"fileRel,omitempty"`
	FilePath      string          `json:"filePath,omitempty"`
	AssetID       string          `json:"assetId,omitempty"`
	ActualStart   *time.Time      `json:"actualStart,omitempty"`
	ActualEnd     *time.Time      `json:"actualEnd,omitempty"`
	DeviationMs   *int64          `json:"startDeviationMs,omitempty"`
	Error         string          `json:"error,omitempty"`
	FailedStage   string          `json:"failedStage,omitempty"`
	Verdicts      []Verdict       `json:"verdicts,omitempty"`
	EarliestStart *time.Time      `json:"earliestStart,omitempty"`
	Storage       Storage         `json:"storage"`
	Metadata      map[string]any  `json:"metadata,omitempty"`
	Late          LatePolicy      `json:"late"`
	Revision      int             `json:"revision"`
	Audio         *AudioPlan      `json:"audio,omitempty"`
	Owner         string          `json:"owner,omitempty"`
	OwnerGroup    string          `json:"ownerGroup,omitempty"`
	CreatedBy     string          `json:"createdBy,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	Extra         json.RawMessage `json:"-"`
}

type Event struct {
	ID        int64          `json:"id"`
	JobID     string         `json:"jobId"`
	At        time.Time      `json:"at"`
	FromState string         `json:"fromState,omitempty"`
	ToState   string         `json:"toState,omitempty"`
	Message   string         `json:"message"`
	Detail    map[string]any `json:"detail,omitempty"`
}

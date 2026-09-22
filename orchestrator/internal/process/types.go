// Package process implementiert die Business-Prozess-Engine-Domäne aus
// Kapitel 21 (UMSETZUNG.md §6b), Phase 2 (Domain Model + Persistenz,
// noch keine Ausführungslogik — Retry/Conditions/Recovery folgen in
// Phase 3). Bewusst NICHT "workflow" genannt und ein eigenständiges
// Paket, nicht Teil von internal/workflows: das bestehende Paket dort
// ist ein Deployment-Bündel aus Node-Rollen (Regieplatz, §6.2) — ein
// fachlich anderes Konzept, das zufällig denselben Umgangssprache-Namen
// "Workflow" trägt (UMSETZUNG.md §6b/21.2, vom Nutzer am 2026-09-22
// bestätigte Trennung). Operator-/UI-Text darf weiterhin "Workflow"
// sagen; Paket-/API-Ebene bleibt eindeutig "Process".
package process

import (
	"encoding/json"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// StepType ist die Art eines Schritts innerhalb einer ProcessDefinition
// (Aufgabenstellung Teil A1, vollständige Liste — jeder Typ hat seine
// eigene, typspezifische Config als JSON in Step.Config, interpretiert
// erst von der Runtime in Phase 3).
type StepType string

const (
	StepTypeTask          StepType = "task"
	StepTypeMediaFunction StepType = "media_function"
	StepTypeServiceCall   StepType = "service_call"
	StepTypeScript        StepType = "script"
	StepTypeCondition     StepType = "condition"
	StepTypeBranch        StepType = "branch"
	StepTypeParallel      StepType = "parallel"
	StepTypeJoin          StepType = "join"
	StepTypeLoop          StepType = "loop"
	StepTypeWait          StepType = "wait"
	StepTypeTimer         StepType = "timer"
	StepTypeHumanTask     StepType = "human_task"
	StepTypeApproval      StepType = "approval"
	StepTypeNotification  StepType = "notification"
	StepTypeEventTrigger  StepType = "event_trigger"
	StepTypeSubworkflow   StepType = "subworkflow"
	StepTypeCompensation  StepType = "compensation"
)

// RetryPolicy konfiguriert Fehlerstrategie eines Schritts (A4). Backoff
// ist ein freies Textfeld ("exponential"/"fixed"), keine harte Go-Enum —
// die Runtime (Phase 3) validiert den Wert, das Domain Model bleibt
// erweiterbar ohne Migration.
type RetryPolicy struct {
	MaxAttempts  int    `json:"maxAttempts"`
	Backoff      string `json:"backoff,omitempty"`
	InitialDelay string `json:"initialDelay,omitempty"` // Go-Duration-String, z. B. "2s"
	MaxDelay     string `json:"maxDelay,omitempty"`
}

// Step ist ein einzelner Knoten im Schritt-Graph einer ProcessDefinition.
//
//   - Next: einfache, unbedingte Folgeschritte (Task/Script/…, mehr als
//     einer = impliziter Parallel-Fan-out ohne eigenen Parallel-Knoten).
//   - Branches: bedingte Folgeschritte für Condition/Branch (Label, z. B.
//     "valid"/"invalid" oder "approve"/"reject", -> Ziel-Step-ID).
//   - CompensationStepID: für Compensation-fähige Schritte (A4: "Ein
//     Step darf bei einem Retry keine unkontrollierten Duplikate
//     erzeugen" — Kompensation ist die dokumentierte Gegenaktion).
//
// Config ist absichtlich schemafrei (json.RawMessage) — jeder StepType
// hat andere Felder (Media-Function-Referenz, Skript-Kommando,
// Condition-Expression, Wait-Dauer, …); ein einziges starres Go-Struct
// für alle 17 Typen wäre entweder unvollständig oder voller ungenutzter
// Felder. Validierung des Config-Inhalts je Typ ist Phase-3-Aufgabe
// (Runtime kennt die Typ-Semantik), Validate() hier prüft nur die
// Graph-Struktur (Referenzen, s. validate.go).
type Step struct {
	ID                 string            `json:"id"`
	Type               StepType          `json:"type"`
	Name               string            `json:"name,omitempty"`
	Config             json.RawMessage   `json:"config,omitempty"`
	Next               []string          `json:"next,omitempty"`
	Branches           map[string]string `json:"branches,omitempty"`
	Retry              *RetryPolicy      `json:"retry,omitempty"`
	TimeoutSeconds     int               `json:"timeoutSeconds,omitempty"`
	CompensationStepID string            `json:"compensationStepId,omitempty"`
}

// EventTrigger bindet eine ProcessDefinition an ein Bus-Event (A8:
// "event -> workflow trigger"). Subject folgt der bestehenden
// eventbus-Konvention ("omp.<domäne>.…", s. internal/eventbus) —
// tatsächliches Abonnieren/Auslösen ist Phase-3/4-Runtime-Aufgabe
// (A8/B9 selbst brauchen zudem noch eine Zuverlässigkeits-Entscheidung,
// UMSETZUNG.md §6b/21.4 Punkt 4, JetStream vs. Outbox — hier nur das
// Datenmodell für "auf welches Event reagiert diese Definition").
type EventTrigger struct {
	Subject string `json:"subject"`
	Filter  string `json:"filter,omitempty"` // optionaler Expressions-Filter, Phase 3
}

// Definition ist der vollständige, in einer ProcessVersion eingefrorene
// Schritt-Graph (A1). StartStepID markiert den Einstiegspunkt.
type Definition struct {
	Steps       []Step         `json:"steps"`
	StartStepID string         `json:"startStepId"`
	Triggers    []EventTrigger `json:"triggers,omitempty"`
}

// ProcessVersion-Status (A7).
const (
	VersionStatusDraft      = "draft"
	VersionStatusPublished  = "published"
	VersionStatusDeprecated = "deprecated"
	VersionStatusArchived   = "archived"
)

// VersionTransitions ist der erlaubte Lifecycle einer ProcessVersion
// (A7: draft -> published -> deprecated -> archived; ein Draft kann auch
// direkt archiviert werden, z. B. verworfener Entwurf, ohne je
// veröffentlicht gewesen zu sein).
var VersionTransitions = statemachine.New([][2]string{
	{VersionStatusDraft, VersionStatusPublished},
	{VersionStatusDraft, VersionStatusArchived},
	{VersionStatusPublished, VersionStatusDeprecated},
	{VersionStatusPublished, VersionStatusArchived},
	{VersionStatusDeprecated, VersionStatusArchived},
})

// ExecutionStatus-Werte (A2) — gemeinsam von ProcessExecution UND
// ProcessStepExecution genutzt (identische Zustandsmenge/-übergänge auf
// beiden Ebenen, s. StepStatusTransitions).
const (
	StatusPending      = "pending"
	StatusRunning      = "running"
	StatusWaiting      = "waiting"
	StatusPaused       = "paused"
	StatusCompleted    = "completed"
	StatusFailed       = "failed"
	StatusCancelled    = "cancelled"
	StatusTimedOut     = "timed_out"
	StatusCompensating = "compensating"
	StatusCompensated  = "compensated"
)

// ExecutionTransitions gilt für ProcessExecution.Status.
var ExecutionTransitions = statemachine.New([][2]string{
	{StatusPending, StatusRunning},
	{StatusPending, StatusCancelled},
	{StatusRunning, StatusWaiting},
	{StatusWaiting, StatusRunning},
	{StatusRunning, StatusPaused},
	{StatusPaused, StatusRunning},
	{StatusRunning, StatusCompleted},
	{StatusRunning, StatusFailed},
	{StatusWaiting, StatusFailed},
	{StatusRunning, StatusCancelled},
	{StatusWaiting, StatusCancelled},
	{StatusPaused, StatusCancelled},
	{StatusRunning, StatusTimedOut},
	{StatusWaiting, StatusTimedOut},
	{StatusFailed, StatusCompensating},
	{StatusTimedOut, StatusCompensating},
	{StatusCancelled, StatusCompensating},
	{StatusCompensating, StatusCompensated},
	{StatusCompensating, StatusFailed},
})

// StepExecutionTransitions gilt für ProcessStepExecution.Status — engere
// Teilmenge (kein Paused: Pausieren ist eine Execution-weite Aktion,
// s. A2/A9 "POST .../pause"; ein einzelner Schritt läuft entweder oder
// nicht).
var StepExecutionTransitions = statemachine.New([][2]string{
	{StatusPending, StatusRunning},
	{StatusRunning, StatusWaiting},
	{StatusWaiting, StatusRunning},
	{StatusRunning, StatusCompleted},
	{StatusRunning, StatusFailed},
	{StatusWaiting, StatusFailed},
	{StatusRunning, StatusCancelled},
	{StatusWaiting, StatusCancelled},
	{StatusRunning, StatusTimedOut},
	{StatusWaiting, StatusTimedOut},
	{StatusFailed, StatusCompensating},
	{StatusCompensating, StatusCompensated},
	{StatusCompensating, StatusFailed},
	// Retry (A4): ein fehlgeschlagener Schritt kann erneut laufen, ohne
	// eine neue StepExecution-Zeile anzulegen — Attempt zählt hoch
	// (Store.IncrementAttempt), Status kehrt nach Pending zurück.
	{StatusFailed, StatusPending},
})

// runEndStatuses sind die Status-Werte, bei denen ein einzelner
// Ausführungs-/Schrittlauf JETZT zu Ende ist (completed_at wird
// gestempelt) — bewusst NICHT dasselbe wie statemachine.Machine.IsTerminal:
// "failed" hat in ExecutionTransitions/StepExecutionTransitions weitere
// gültige Folgeübergänge (-> compensating, bei Schritten auch -> pending
// für einen Retry), ist also graphisch nicht terminal, obwohl der GERADE
// LAUFENDE Versuch in diesem Moment sehr wohl beendet ist. IsTerminal
// beantwortet "kann sich dieser Zustand je wieder ändern", diese Liste
// beantwortet "ist der aktuelle Lauf gerade zu Ende" — zwei verschiedene
// Fragen, die hier bewusst getrennt bleiben statt eine über die andere zu
// approximieren (das war ein echter, per DB-Test gefundener Bug: ein
// UPDATE auf "failed" setzte mit IsTerminal(false) fälschlich nie
// completed_at).
var runEndStatuses = map[string]struct{}{
	StatusCompleted:   {},
	StatusFailed:      {},
	StatusCancelled:   {},
	StatusTimedOut:    {},
	StatusCompensated: {},
}

// isRunEndStatus meldet, ob status einen abgeschlossenen Lauf markiert
// (s. runEndStatuses-Doku) — genutzt von Store.UpdateExecutionStatus/
// UpdateStepExecutionStatus, um completed_at zu setzen.
func isRunEndStatus(status string) bool {
	_, ok := runEndStatuses[status]
	return ok
}

// HumanTask-Status (A6 — Zustände, die aus den geforderten Aktionen
// assign/claim/release/approve/reject/request-changes/delegate/cancel/
// escalate/timeout resultieren). "assign"/"release" ändern nur das
// Assignee-Feld, nicht zwingend den Status (ein zugewiesener, aber noch
// nicht geclaimter Task bleibt "pending") — deshalb keine eigenen
// Status-Werte dafür.
const (
	HumanTaskStatusPending          = "pending"
	HumanTaskStatusClaimed          = "claimed"
	HumanTaskStatusApproved         = "approved"
	HumanTaskStatusRejected         = "rejected"
	HumanTaskStatusChangesRequested = "changes_requested"
	HumanTaskStatusDelegated        = "delegated"
	HumanTaskStatusCancelled        = "cancelled"
	HumanTaskStatusEscalated        = "escalated"
	HumanTaskStatusTimedOut         = "timed_out"
)

// HumanTaskTransitions.
var HumanTaskTransitions = statemachine.New([][2]string{
	{HumanTaskStatusPending, HumanTaskStatusClaimed},
	{HumanTaskStatusClaimed, HumanTaskStatusPending}, // release
	{HumanTaskStatusClaimed, HumanTaskStatusApproved},
	{HumanTaskStatusClaimed, HumanTaskStatusRejected},
	{HumanTaskStatusClaimed, HumanTaskStatusChangesRequested},
	{HumanTaskStatusPending, HumanTaskStatusDelegated},
	{HumanTaskStatusClaimed, HumanTaskStatusDelegated},
	{HumanTaskStatusDelegated, HumanTaskStatusPending},
	{HumanTaskStatusPending, HumanTaskStatusCancelled},
	{HumanTaskStatusClaimed, HumanTaskStatusCancelled},
	{HumanTaskStatusPending, HumanTaskStatusEscalated},
	{HumanTaskStatusClaimed, HumanTaskStatusEscalated},
	{HumanTaskStatusEscalated, HumanTaskStatusPending},
	{HumanTaskStatusPending, HumanTaskStatusTimedOut},
	{HumanTaskStatusClaimed, HumanTaskStatusTimedOut},
})

// ProcessDefinition ist der benannte Container einer Prozess-Familie —
// Versionen (ProcessVersion) tragen den eigentlichen Schritt-Graph, die
// Definition selbst ist nur Name/Metadaten (Analogie: ein Katalog-
// Node-Typ vs. seine Versionen, §17 Teil 5).
type ProcessDefinition struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Category    string    `json:"category,omitempty"`
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ProcessVersion ist ein konkreter, ab Publish unveränderlicher
// Schritt-Graph unter einer ProcessDefinition (A7).
type ProcessVersion struct {
	ID                  string     `json:"id"`
	ProcessDefinitionID string     `json:"processDefinitionId"`
	VersionNumber       int        `json:"versionNumber"`
	Status              string     `json:"status"`
	Definition          Definition `json:"definition"`
	CreatedBy           string     `json:"createdBy"`
	CreatedAt           time.Time  `json:"createdAt"`
	PublishedAt         *time.Time `json:"publishedAt,omitempty"`
}

// ProcessExecution ist ein laufender/abgeschlossener Lauf einer
// ProcessVersion (A2). CorrelationID/CausationID/ParentExecutionID
// tragen die in A2/A8 geforderte Nachverfolgbarkeit; TraceID verknüpft
// mit der bestehenden orchestrator/internal/tracing-Korrelation (B15,
// reuse statt Neuerfindung).
type ProcessExecution struct {
	ID                  string          `json:"id"`
	ProcessDefinitionID string          `json:"processDefinitionId"`
	ProcessVersionID    string          `json:"processVersionId"`
	Status              string          `json:"status"`
	CorrelationID       string          `json:"correlationId"`
	CausationID         string          `json:"causationId,omitempty"`
	ParentExecutionID   string          `json:"parentExecutionId,omitempty"`
	TraceID             string          `json:"traceId,omitempty"`
	Input               json.RawMessage `json:"input,omitempty"`
	Output              json.RawMessage `json:"output,omitempty"`
	Error               string          `json:"error,omitempty"`
	CreatedBy           string          `json:"createdBy"`
	RowVersion          int             `json:"rowVersion"`
	StartedAt           time.Time       `json:"startedAt"`
	UpdatedAt           time.Time       `json:"updatedAt"`
	CompletedAt         *time.Time      `json:"completedAt,omitempty"`
}

// ProcessStepExecution ist ein einzelner Schrittlauf innerhalb einer
// ProcessExecution (A2). Attempt zählt Retry-Versuche (A4) — ein Retry
// erzeugt KEINE neue Zeile, s. StepExecutionTransitions-Kommentar
// (Idempotenz-Anforderung A3: dieselbe Zeile, nicht dauerhaft wachsende
// Historie pro Versuch).
type ProcessStepExecution struct {
	ID                 string          `json:"id"`
	ProcessExecutionID string          `json:"processExecutionId"`
	StepID             string          `json:"stepId"`
	StepType           StepType        `json:"stepType"`
	Status             string          `json:"status"`
	Attempt            int             `json:"attempt"`
	Input              json.RawMessage `json:"input,omitempty"`
	Output             json.RawMessage `json:"output,omitempty"`
	Error              string          `json:"error,omitempty"`
	RowVersion         int             `json:"rowVersion"`
	StartedAt          time.Time       `json:"startedAt"`
	UpdatedAt          time.Time       `json:"updatedAt"`
	CompletedAt        *time.Time      `json:"completedAt,omitempty"`
}

// HumanTask (A6) — Felder exakt wie in der Aufgabenstellung aufgezählt.
type HumanTask struct {
	ID                 string     `json:"id"`
	ProcessExecutionID string     `json:"processExecutionId"`
	StepExecutionID    string     `json:"stepExecutionId,omitempty"`
	Title              string     `json:"title"`
	Description        string     `json:"description,omitempty"`
	Assignee           string     `json:"assignee,omitempty"`
	Role               string     `json:"role,omitempty"`
	Priority           string     `json:"priority,omitempty"`
	Status             string     `json:"status"`
	Decision           string     `json:"decision,omitempty"`
	Comment            string     `json:"comment,omitempty"`
	RowVersion         int        `json:"rowVersion"`
	Deadline           *time.Time `json:"deadline,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	CompletedAt        *time.Time `json:"completedAt,omitempty"`
}

package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ErrStepWaiting ist ein Sentinel-Fehler: der Executor hat seine Arbeit
// angestoßen (z. B. einen HumanTask angelegt, eine Sub-Execution
// gestartet), ist aber noch nicht fertig — die Engine setzt den
// Schritt-Status auf "waiting" und ruft Execute() beim nächsten Poll
// erneut auf. Executors, die dies zurückgeben, MÜSSEN beim erneuten
// Aufruf idempotent prüfen, ob ihre Arbeit bereits angestoßen wurde,
// statt sie zu wiederholen (s. humanTaskExecutor/subworkflowExecutor).
var ErrStepWaiting = errors.New("process: step still waiting")

// ErrNoExecutorRegistered wird geliefert, wenn ein Schritt einen Typ
// hat, für den kein StepExecutor registriert ist — eine ehrliche,
// sichtbare Fehlermeldung statt eines stillen No-op/Mock-Erfolgs
// (Projektgrundsatz "keine Mock-Implementierung"). Task/MediaFunction/
// ServiceCall/Script/Condition/Branch/Loop/EventTrigger/Compensation
// brauchen entweder eine sichere Expression Language (A5, Teil 2) oder
// eine echte externe Integration (Media Functions/MXL/NMOS, Phase 4)
// und sind deshalb in dieser Runde bewusst UNREGISTRIERT, nicht durch
// Platzhalter-Logik ersetzt.
var ErrNoExecutorRegistered = errors.New("process: no executor registered for step type")

// ExecutionCtx ist der Datenkontext, den ein StepExecutor beim Aufruf
// bekommt — die laufende Execution plus die bisher gesammelten Outputs
// abgeschlossener Geschwister-Schritte (stepID -> Output). Bewusst ohne
// Expression-Auswertung (das ist A5/Teil 2) — Teil-1-Executors lesen
// höchstens direkt aus Outputs/Step.Config.
type ExecutionCtx struct {
	Execution ProcessExecution
	StepExec  ProcessStepExecution
	Outputs   map[string]json.RawMessage
}

// StepExecutor führt die typspezifische Arbeit eines einzelnen Schritts
// aus. Execute MUSS bei wiederholtem Aufruf für denselben Schritt (Poll
// nach ErrStepWaiting, oder nach einem Neustart wiederaufgenommene
// Ausführung) sicher erneut aufrufbar sein — entweder weil die Aktion
// selbst idempotent ist (Wait/Timer/Parallel/Join) oder weil der
// Executor selbst prüft, ob seine Arbeit schon angestoßen wurde
// (HumanTask/Approval/Subworkflow).
type StepExecutor interface {
	Execute(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error)
}

// StepExecutorFunc erlaubt, eine einfache Funktion als StepExecutor zu
// registrieren (gleiches Muster wie http.HandlerFunc).
type StepExecutorFunc func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error)

func (f StepExecutorFunc) Execute(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
	return f(ctx, ec, step)
}

// ---- Wait/Timer -----------------------------------------------

// waitConfig ist Step.Config für Wait/Timer: {"seconds": N}.
type waitConfig struct {
	Seconds int `json:"seconds"`
}

// waitExecutor blockiert, bis Seconds seit dem tatsächlichen Start
// DIESES Schritt-Laufs (StepExec.StartedAt, nicht "jetzt") verstrichen
// sind — wichtig für Recovery: setzt die Engine denselben Schritt nach
// einem Neustart erneut auf, soll nicht die volle Wartezeit von vorn
// beginnen, sondern nur den Rest (A3-Idempotenz-Geist: derselbe Schritt-
// Lauf darf durch einen Neustart nicht dauerhaft verlängert werden).
// Wait und Timer sind identisch implementiert (A1 unterscheidet sie nur
// begrifflich: Timer = fester Zeitpunkt/Dauer, Wait = Pause im Ablauf —
// beide reduzieren sich auf "warte N Sekunden ab Schrittstart").
func waitExecutor(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
	var cfg waitConfig
	if len(step.Config) > 0 {
		if err := json.Unmarshal(step.Config, &cfg); err != nil {
			return nil, fmt.Errorf("process: step %q: invalid wait config: %w", step.ID, err)
		}
	}
	deadline := ec.StepExec.StartedAt.Add(time.Duration(cfg.Seconds) * time.Second)
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return json.RawMessage(`{}`), nil
	}
	select {
	case <-time.After(remaining):
		return json.RawMessage(`{}`), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ---- Parallel/Join -----------------------------------------------

// passthroughExecutor ist der Executor für Parallel/Join — beide sind
// reine Graph-Marker, keine eigene Arbeit: das Auffächern (Parallel,
// mehrere Next-Ziele) und Zusammenführen (Join, mehrere Vorgänger)
// erledigt bereits der generische Frontier-Algorithmus der Engine für
// JEDEN Schritt mit mehreren Next-Einträgen bzw. mehreren Vorgängern —
// Parallel/Join brauchen dafür keinen Sonderfall im Executor, nur die
// beiden Typnamen im Graphen für die Lesbarkeit.
func passthroughExecutor(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

// ---- HumanTask/Approval -----------------------------------------------

// humanTaskConfig ist Step.Config für HumanTask/Approval.
type humanTaskConfig struct {
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Assignee    string `json:"assignee,omitempty"`
	Role        string `json:"role,omitempty"`
	Priority    string `json:"priority,omitempty"`
}

// humanTaskStore ist die Teilmenge von *Store, die der HumanTask-
// Executor braucht — als Interface, damit der Executor unabhängig vom
// konkreten Store-Typ testbar bleibt (gleiches Muster wie
// audit.EventPublisher).
type humanTaskStore interface {
	GetHumanTaskByStepExecution(stepExecutionID string) (HumanTask, error)
	CreateHumanTask(p CreateHumanTaskParams) (HumanTask, error)
}

// newHumanTaskExecutor liefert den Executor für HumanTask- UND
// Approval-Schritte (A6: beide sind aus Runtime-Sicht identisch — ein
// Mensch trifft eine Entscheidung, die Aufgabenstellung selbst zeigt
// "Human Review" als denselben Baustein für Approve/Reject/Changes).
// Idempotent: legt einen HumanTask nur beim ERSTEN Aufruf an
// (ErrStepWaiting), jeder weitere Poll prüft nur noch dessen Status —
// überlebt daher sowohl normales Polling als auch einen
// Engine-Neustart mitten im Warten (GetHumanTaskByStepExecution findet
// den bereits angelegten Task wieder, statt einen zweiten anzulegen).
//
// Das Ergebnis ist der HumanTask selbst (id/status/decision/comment als
// JSON) — für Approval-Schritte kann Step.Branches[decision] (z. B.
// "approve"/"reject"/"changes_requested") den nächsten Schritt wählen
// (engine.go: resolveNextSteps), ganz ohne Expression Language (A5).
func newHumanTaskExecutor(store humanTaskStore) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		task, err := store.GetHumanTaskByStepExecution(ec.StepExec.ID)
		if errors.Is(err, ErrNotFound) {
			var cfg humanTaskConfig
			if len(step.Config) > 0 {
				if err := json.Unmarshal(step.Config, &cfg); err != nil {
					return nil, fmt.Errorf("process: step %q: invalid human task config: %w", step.ID, err)
				}
			}
			title := cfg.Title
			if title == "" {
				title = step.Name
			}
			if title == "" {
				title = step.ID
			}
			task, err = store.CreateHumanTask(CreateHumanTaskParams{
				ProcessExecutionID: ec.Execution.ID,
				StepExecutionID:    ec.StepExec.ID,
				Title:              title,
				Description:        cfg.Description,
				Assignee:           cfg.Assignee,
				Role:               cfg.Role,
				Priority:           cfg.Priority,
			})
			if err != nil {
				return nil, fmt.Errorf("process: step %q: create human task: %w", step.ID, err)
			}
			return nil, ErrStepWaiting
		}
		if err != nil {
			return nil, fmt.Errorf("process: step %q: load human task: %w", step.ID, err)
		}

		if !HumanTaskTransitions.IsTerminal(task.Status) {
			return nil, ErrStepWaiting
		}
		return json.Marshal(task)
	})
}

// ---- Subworkflow -----------------------------------------------

// subworkflowConfig ist Step.Config für Subworkflow: entweder eine
// bereits veröffentlichte konkrete Version, oder eine Definition mit
// "neueste veröffentlichte Version" (empty VersionID = Runtime löst zur
// Aufrufzeit auf — bewusst NICHT implizit "neueste Version" ohne
// Publish-Status-Prüfung, s. subworkflowExecutor).
type subworkflowConfig struct {
	ProcessDefinitionID string          `json:"processDefinitionId"`
	ProcessVersionID    string          `json:"processVersionId,omitempty"`
	Input               json.RawMessage `json:"input,omitempty"`
}

// subworkflowStore ist die Teilmenge von *Store, die der Subworkflow-
// Executor braucht.
type subworkflowStore interface {
	ListVersions(processDefinitionID string) ([]ProcessVersion, error)
	GetVersion(id string) (ProcessVersion, error)
	CreateExecution(p CreateExecutionParams) (ProcessExecution, error)
	GetExecution(id string) (ProcessExecution, error)
	ListExecutions(f ExecutionFilter) ([]ProcessExecution, error)
}

// newSubworkflowExecutor liefert den Executor für Subworkflow-Schritte
// (A1/B10-Vorstufe: "nested workflows" laut Aufgabenstellung). Startet
// eine Kind-Execution mit ParentExecutionID gesetzt (Phase 2 hat dieses
// Feld genau dafür), CorrelationID/CausationID/TraceID wandern von der
// Eltern-Execution durch (A2/A8: Nachverfolgbarkeit über
// Subworkflow-Grenzen hinweg). Idempotent wie der HumanTask-Executor:
// existiert bereits eine Kind-Execution mit dieser Eltern-ID+StepID
// (via CorrelationID als eindeutiger Anker, s. u.), wird keine zweite
// gestartet.
//
// drive stößt — wie Engine.Start es für eine normale Execution tut —
// den treibenden Zyklus der frisch angelegten Kind-Execution an; ohne
// diesen Aufruf bliebe die Kind-Execution für immer im Status "pending"
// liegen (per Store.CreateExecution allein entsteht keine Ausführung,
// nur eine Zeile — echter, per Test gefundener Fehler in einer früheren
// Fassung dieses Executors). drive darf nil sein (z. B. in isolierten
// Executor-Tests ohne Engine) — dann bleibt die Kind-Execution bis zum
// nächsten Engine.RecoverAll() unangetrieben liegen.
func newSubworkflowExecutor(store subworkflowStore, drive func(executionID string)) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg subworkflowConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.ProcessDefinitionID == "" {
			return nil, fmt.Errorf("process: step %q: invalid subworkflow config (processDefinitionId required)", step.ID)
		}

		// Eindeutiger Korrelations-Anker für dieses (Eltern-Execution,
		// Schritt) — überlebt einen Neustart, weil er deterministisch aus
		// bereits persistierten IDs abgeleitet ist, nicht neu gewürfelt
		// wird.
		childCorrelationID := ec.Execution.ID + ":" + ec.StepExec.ID

		existing, err := store.ListExecutions(ExecutionFilter{ParentExecutionID: ec.Execution.ID, CorrelationID: childCorrelationID})
		if err != nil {
			return nil, fmt.Errorf("process: step %q: list child executions: %w", step.ID, err)
		}
		var child ProcessExecution
		if len(existing) > 0 {
			child = existing[0]
		} else {
			versionID := cfg.ProcessVersionID
			if versionID == "" {
				versions, err := store.ListVersions(cfg.ProcessDefinitionID)
				if err != nil {
					return nil, fmt.Errorf("process: step %q: list versions: %w", step.ID, err)
				}
				for _, v := range versions {
					if v.Status == VersionStatusPublished {
						versionID = v.ID
						break
					}
				}
				if versionID == "" {
					return nil, fmt.Errorf("process: step %q: no published version of definition %q", step.ID, cfg.ProcessDefinitionID)
				}
			}
			child, err = store.CreateExecution(CreateExecutionParams{
				ProcessDefinitionID: cfg.ProcessDefinitionID,
				ProcessVersionID:    versionID,
				CorrelationID:       childCorrelationID,
				CausationID:         ec.Execution.ID,
				ParentExecutionID:   ec.Execution.ID,
				TraceID:             ec.Execution.TraceID,
				CreatedBy:           ec.Execution.CreatedBy,
				Input:               cfg.Input,
			})
			if err != nil {
				return nil, fmt.Errorf("process: step %q: create child execution: %w", step.ID, err)
			}
			if drive != nil {
				drive(child.ID)
			}
			return nil, ErrStepWaiting
		}

		child, err = store.GetExecution(child.ID)
		if err != nil {
			return nil, fmt.Errorf("process: step %q: reload child execution: %w", step.ID, err)
		}
		if !isRunEndStatus(child.Status) {
			return nil, ErrStepWaiting
		}
		if child.Status != StatusCompleted {
			return nil, fmt.Errorf("process: step %q: child execution %s ended with status %s", step.ID, child.ID, child.Status)
		}
		return child.Output, nil
	})
}

// ---- Notification -----------------------------------------------

// EventPublisher ist die minimale Bus-Schnittstelle, die der
// Notification-Executor braucht (gleiches nil-sicheres Muster wie
// audit.EventPublisher/graph.EventPublisher) — Subject folgt der
// bestehenden "omp.<domäne>.…"-Konvention (internal/eventbus).
type EventPublisher interface {
	Publish(subject string, payload []byte) error
}

// notificationConfig ist Step.Config für Notification.
type notificationConfig struct {
	Subject string          `json:"subject"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// newNotificationExecutor liefert den Executor für Notification-
// Schritte. Bewusst fire-and-forget wie der Rest von internal/eventbus
// (kein JetStream, keine Zustellgarantie, s. UMSETZUNG.md §6b/21.4
// Punkt 4) — ein nil EventPublisher lässt den Schritt NICHT scheitern,
// sondern loggt nur eine Warnung (kein Bus konfiguriert ist ein
// Betriebszustand, kein Programmfehler).
func newNotificationExecutor(publisher EventPublisher) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg notificationConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.Subject == "" {
			return nil, fmt.Errorf("process: step %q: invalid notification config (subject required)", step.ID)
		}
		if publisher == nil {
			slog.Warn("process: notification step has no event publisher configured, skipping", "step", step.ID, "subject", cfg.Subject)
			return json.RawMessage(`{}`), nil
		}
		payload := []byte(cfg.Payload)
		if len(payload) == 0 {
			payload = []byte(`{}`)
		}
		if err := publisher.Publish(cfg.Subject, payload); err != nil {
			return nil, fmt.Errorf("process: step %q: publish: %w", step.ID, err)
		}
		return json.RawMessage(`{}`), nil
	})
}

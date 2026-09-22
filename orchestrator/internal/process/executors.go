package process

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
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

// ---- Condition/Branch (A5, Kapitel 21 Phase 3 Teil 2) -----------------------------------------------

// decisionOutput ist die einheitliche Output-Form von Condition/Branch/
// HumanTask/Approval — resolveSuccessors (engine.go) liest daraus
// ausschließlich das "decision"-Feld, alles andere ist informativ.
type decisionOutput struct {
	Decision string `json:"decision"`
	Result   *bool  `json:"result,omitempty"`
}

// conditionConfig ist Step.Config für Condition: ein einzelner boolescher
// Ausdruck (A5), TrueLabel/FalseLabel wählen das Branches-Ziel (Default
// "true"/"false" — passend zu einer Definition, die Branches gar nicht
// umbenennt).
type conditionConfig struct {
	Expression string `json:"expression"`
	TrueLabel  string `json:"trueLabel,omitempty"`
	FalseLabel string `json:"falseLabel,omitempty"`
}

// newConditionExecutor liefert den Executor für Condition-Schritte
// (A1/A5). Das Ergebnis ist KEIN Next-Fan-out, sondern eine Branches-
// Entscheidung wie bei HumanTask/Approval — dieselbe generische
// resolveSuccessors-Logik (engine.go) wählt anhand von output.decision
// genau EIN Branches-Ziel, ganz ohne Sonderfall-Code für Condition.
func newConditionExecutor(eval *Evaluator) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg conditionConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.Expression == "" {
			return nil, fmt.Errorf("process: step %q: invalid condition config (expression required)", step.ID)
		}
		result, err := eval.EvalBool(cfg.Expression, exprVars(ec))
		if err != nil {
			return nil, fmt.Errorf("process: step %q: %w", step.ID, err)
		}
		trueLabel := cfg.TrueLabel
		if trueLabel == "" {
			trueLabel = "true"
		}
		falseLabel := cfg.FalseLabel
		if falseLabel == "" {
			falseLabel = "false"
		}
		decision := falseLabel
		if result {
			decision = trueLabel
		}
		return json.Marshal(decisionOutput{Decision: decision, Result: &result})
	})
}

// branchCase ist ein einzelner Fall eines Branch-Schritts — Ausdrücke
// werden der Reihe nach ausgewertet, der ERSTE zutreffende gewinnt
// (klassische switch/case-Semantik, nicht "alle passenden").
type branchCase struct {
	Expression string `json:"expression"`
	Label      string `json:"label"`
}

// branchConfig ist Step.Config für Branch: mehrere Fälle + optionales
// Default-Label, falls keiner zutrifft.
type branchConfig struct {
	Cases        []branchCase `json:"cases"`
	DefaultLabel string       `json:"defaultLabel,omitempty"`
}

// newBranchExecutor liefert den Executor für Branch-Schritte (A1/A5) —
// der mehrwertige Bruder von Condition (mehr als zwei mögliche Ziele
// statt nur true/false). Kein zutreffender Fall UND kein DefaultLabel
// ist ein ehrlicher Fehler (kein stiller Stillstand — ein Branch ohne
// erreichbares Ziel ist ein Definitionsfehler, kein Laufzeit-Normalfall).
func newBranchExecutor(eval *Evaluator) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg branchConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || len(cfg.Cases) == 0 {
			return nil, fmt.Errorf("process: step %q: invalid branch config (at least one case required)", step.ID)
		}
		vars := exprVars(ec)
		for _, c := range cfg.Cases {
			if c.Label == "" {
				return nil, fmt.Errorf("process: step %q: branch case with empty label", step.ID)
			}
			ok, err := eval.EvalBool(c.Expression, vars)
			if err != nil {
				return nil, fmt.Errorf("process: step %q: case %q: %w", step.ID, c.Label, err)
			}
			if ok {
				return json.Marshal(decisionOutput{Decision: c.Label})
			}
		}
		if cfg.DefaultLabel == "" {
			return nil, fmt.Errorf("process: step %q: no branch case matched and no defaultLabel configured", step.ID)
		}
		return json.Marshal(decisionOutput{Decision: cfg.DefaultLabel})
	})
}

// ---- ServiceCall (A1, Kapitel 21 Phase 4 Teil 2) -----------------------------------------------

// serviceCallConfig ist Step.Config für ServiceCall — ein generischer
// HTTP-Aufruf gegen JEDEN Dienst (einen OMP-Node über dessen Standard-
// HTTP-API, oder einen echten externen Dienst). Bewusst kein
// Sonderwissen über OMP-Nodes hier (das ist MediaFunction, s. u.) —
// ServiceCall ist der allgemeinste der vier A1-Integrations-Schritt-
// Typen.
type serviceCallConfig struct {
	Method         string            `json:"method,omitempty"` // Default GET
	URL            string            `json:"url"`
	Headers        map[string]string `json:"headers,omitempty"`
	Body           json.RawMessage   `json:"body,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
}

// serviceCallOutput ist der Output eines ServiceCall-Schritts.
type serviceCallOutput struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

const defaultServiceCallTimeout = 30 * time.Second

// NewServiceCallExecutor liefert den Executor für ServiceCall-Schritte —
// exportiert, main.go (Phase 5) registriert ihn per Engine.Register.
// httpClient darf nil sein (http.DefaultClient). Bewusst NICHT
// automatisch in NewEngine registriert (anders als die rein
// strukturellen Typen aus Phase 3 Teil 1) — ServiceCall braucht echte
// Netzinfrastruktur (ggf. mTLS-Client, UMSETZUNG.md D3), die erst der
// Aufrufer (main.go, Phase 5, oder ein Test) kennt; Register() ist der
// dafür vorgesehene Erweiterungspunkt (s. engine.go).
//
// Sicherheitshinweis (B14, noch offen aus Kapitel-21-Phase-1): wer eine
// ProcessDefinition mit einem ServiceCall-Schritt veröffentlichen darf,
// bestimmt implizit, welche internen/externen HTTP-Ziele der
// Orchestrator-Prozess erreichen kann (SSRF-ähnliche Fläche) — ohne
// granulare Autorisierung ist das bewusst dieselbe Vertrauensannahme
// wie bei internal/workflows' bestehenden Node-Aufrufen (nur
// authentifizierte, mit configure/admin-Verb ausgestattete Nutzer
// dürfen Definitionen anlegen, sobald die Phase-5-API das durchsetzt).
func NewServiceCallExecutor(httpClient *http.Client) StepExecutor {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg serviceCallConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.URL == "" {
			return nil, fmt.Errorf("process: step %q: invalid service call config (url required)", step.ID)
		}
		method := cfg.Method
		if method == "" {
			method = http.MethodGet
		}
		timeout := defaultServiceCallTimeout
		if cfg.TimeoutSeconds > 0 {
			timeout = time.Duration(cfg.TimeoutSeconds) * time.Second
		}
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		var bodyReader io.Reader
		if len(cfg.Body) > 0 {
			bodyReader = bytes.NewReader(cfg.Body)
		}
		req, err := http.NewRequestWithContext(reqCtx, method, cfg.URL, bodyReader)
		if err != nil {
			return nil, fmt.Errorf("process: step %q: build request: %w", step.ID, err)
		}
		if len(cfg.Body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range cfg.Headers {
			req.Header.Set(k, v)
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("process: step %q: service call: %w", step.ID, err)
		}
		defer resp.Body.Close()
		respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB — ein Schritt-Output ist kein Medien-Transport
		if err != nil {
			return nil, fmt.Errorf("process: step %q: read response: %w", step.ID, err)
		}
		out := serviceCallOutput{Status: resp.StatusCode}
		if json.Valid(respBody) {
			out.Body = respBody
		} else if len(respBody) > 0 {
			marshaled, _ := json.Marshal(string(respBody))
			out.Body = marshaled
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			raw, _ := json.Marshal(out)
			return raw, fmt.Errorf("process: step %q: service call returned status %d", step.ID, resp.StatusCode)
		}
		return json.Marshal(out)
	})
}

// ---- MediaFunction (A1, Kapitel 21 Phase 4 Teil 2) -----------------------------------------------

// mediaFunctionConfig ist Step.Config für MediaFunction: ruft eine
// selbstbeschriebene Methode (IS-12/14-inspiriertes Node-Contract-
// Muster, ARCHITECTURE.md §2/§5) einer LAUFENDEN OMP-Node-Instanz auf —
// z. B. "record.start" auf einem omp-recorder, "show" auf einem
// omp-ograf. InstanceID ist die stabile, vom Launcher vergebene
// Instanz-ID (registry.NodeView.InstanceID, UMSETZUNG.md C8) — NICHT
// die bei jedem Prozessstart neue NMOS-Node-ID.
type mediaFunctionConfig struct {
	InstanceID string          `json:"instanceId"`
	Method     string          `json:"method"`
	Args       json.RawMessage `json:"args,omitempty"`
}

// newMediaFunctionExecutor liefert den Executor für MediaFunction-
// Schritte — löst InstanceID über resolver zur aktuell erreichbaren
// Node-Basis-URL auf (nodeclient.go) und ruft dort die Methode über den
// generischen Node-Contract-Pfad auf (`POST /methods/<name>`, exakt
// dasselbe Wire-Protokoll wie internal/workflows' Crosspoint-Aufrufe
// und nodes/omp-node-sdk/src/server.rs route()). Bewusst NICHT
// automatisch registriert (s. NewServiceCallExecutor-Doku) — braucht
// einen echten NodeResolver (main.go, Phase 5). Nimmt bewusst das
// unexportierte methodInvoker-Interface (statt direkt *http.Client) als
// Testnaht — s. NewMediaFunctionExecutor für den exportierten
// Regelfall-Konstruktor mit echtem HTTP-Invoker.
//
// Ist die Instanz gerade nicht online/registriert, scheitert der
// Schritt ehrlich (ErrConcurrentModification-artig retrybar über A4,
// falls Step.Retry gesetzt ist) statt eines stillen No-op — ein Node
// kann durchaus zwischen zwei Retry-Versuchen wieder online kommen.
func newMediaFunctionExecutor(resolver NodeResolver, invoker methodInvoker) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg mediaFunctionConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.InstanceID == "" || cfg.Method == "" {
			return nil, fmt.Errorf("process: step %q: invalid media function config (instanceId and method required)", step.ID)
		}
		baseURL, ok := resolver.ResolveAPIBaseURL(cfg.InstanceID)
		if !ok {
			return nil, fmt.Errorf("process: step %q: media function instance %q not found or offline", step.ID, cfg.InstanceID)
		}
		out, err := invoker.Invoke(ctx, baseURL, cfg.Method, cfg.Args)
		if err != nil {
			return nil, fmt.Errorf("process: step %q: %w", step.ID, err)
		}
		return out, nil
	})
}

// NewMediaFunctionExecutor ist der exportierte Regelfall-Konstruktor —
// main.go (Phase 5) registriert ihn per Engine.Register, ohne das
// unexportierte methodInvoker-Interface (Testnaht, s. o.) selbst kennen
// zu müssen. httpClient darf nil sein (http.DefaultClient).
func NewMediaFunctionExecutor(resolver NodeResolver, httpClient *http.Client) StepExecutor {
	return newMediaFunctionExecutor(resolver, newHTTPMethodInvoker(httpClient))
}

// ---- Script (A1, Kapitel 21 Phase 4 Teil 2) -----------------------------------------------

// scriptConfig ist Step.Config für Script. Command MUSS ein Schlüssel
// der dem Executor übergebenen Allow-Liste sein (s. newScriptExecutor-
// Doku) — NIE ein roher Pfad/beliebiges Programm. Args-Einträge, die
// exakt der Form "${<expr-lang-Ausdruck>}" entsprechen, werden gegen
// denselben Kontext ausgewertet wie Condition/Branch (input/outputs/
// workflow, s. expr.go) und durch ihren Stringwert ersetzt — erlaubt
// z. B. den von einem vorherigen Schritt gelieferten Dateipfad an
// ffmpeg/ffprobe durchzureichen, ohne einen zweiten Templating-
// Mechanismus zu erfinden.
type scriptConfig struct {
	Command        string   `json:"command"`
	Args           []string `json:"args,omitempty"`
	TimeoutSeconds int      `json:"timeoutSeconds,omitempty"`
}

// scriptOutput ist der Output eines Script-Schritts.
type scriptOutput struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
}

const defaultScriptTimeout = 5 * time.Minute
const maxScriptOutputBytes = 1 << 20 // 1 MiB je Strom — ein Steuerungs-Output, kein Mediencontainer

// NewScriptExecutor liefert den Executor für Script-Schritte —
// exportiert, main.go (Phase 5) registriert ihn per Engine.Register.
// Aufgabenstellungs-Zusatzwunsch: "Datei-Workflows nach Möglichkeit auf
// ffmpeg aufbauen". allowedCommands bildet einen im Graphen
// referenzierbaren Namen (Config.Command) auf den TATSÄCHLICHEN,
// absoluten Programmpfad ab — dieselbe Sicherheitsgrenze wie
// internal/launchers "Katalog statt beliebiger Kommandos" (UMSETZUNG.md
// §6.2: "der Orchestrator startet NUR Katalog-Einträge, keine freien
// Kommandos"). Ein leeres allowedCommands macht JEDEN Script-Schritt
// ehrlich fehlschlagen statt heimlich Programme aus dem PATH zu
// akzeptieren — main.go entscheidet bewusst, was erlaubt ist, per
// exec.LookPath ermittelt statt geraten (z. B. {"ffprobe": "/usr/bin/
// ffprobe", "ffmpeg": "/usr/bin/ffmpeg"}, falls auf dem Host installiert).
func NewScriptExecutor(allowedCommands map[string]string, eval *Evaluator) StepExecutor {
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var cfg scriptConfig
		if err := json.Unmarshal(step.Config, &cfg); err != nil || cfg.Command == "" {
			return nil, fmt.Errorf("process: step %q: invalid script config (command required)", step.ID)
		}
		binary, ok := allowedCommands[cfg.Command]
		if !ok {
			return nil, fmt.Errorf("process: step %q: command %q is not in the allow-list", step.ID, cfg.Command)
		}

		vars := exprVars(ec)
		args := make([]string, len(cfg.Args))
		for i, a := range cfg.Args {
			resolved, err := resolveScriptArg(eval, vars, a)
			if err != nil {
				return nil, fmt.Errorf("process: step %q: resolve arg %d: %w", step.ID, i, err)
			}
			args[i] = resolved
		}

		timeout := defaultScriptTimeout
		if cfg.TimeoutSeconds > 0 {
			timeout = time.Duration(cfg.TimeoutSeconds) * time.Second
		}
		runCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		cmd := exec.CommandContext(runCtx, binary, args...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &limitedWriter{w: &stdout, max: maxScriptOutputBytes}
		cmd.Stderr = &limitedWriter{w: &stderr, max: maxScriptOutputBytes}
		runErr := cmd.Run()

		out := scriptOutput{
			ExitCode: cmd.ProcessState.ExitCode(),
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
		}
		raw, marshalErr := json.Marshal(out)
		if marshalErr != nil {
			return nil, fmt.Errorf("process: step %q: marshal script output: %w", step.ID, marshalErr)
		}
		if runErr != nil {
			// raw wird bewusst NICHT zurückgegeben (StepExecutor-Vertrag:
			// bei Fehler ist der zweite Rückgabewert maßgeblich) — Stdout/
			// Stderr stehen aber vollständig in der Fehlermeldung, damit
			// ein Fehlschlag nicht kontextlos ist.
			return nil, fmt.Errorf("process: step %q: command %q failed: %w (stderr: %s)", step.ID, cfg.Command, runErr, truncate(out.Stderr, 500))
		}
		return raw, nil
	})
}

// resolveScriptArg löst ein einzelnes Script-Argument auf — s.
// scriptConfig-Doku.
func resolveScriptArg(eval *Evaluator, vars map[string]any, arg string) (string, error) {
	if !strings.HasPrefix(arg, "${") || !strings.HasSuffix(arg, "}") {
		return arg, nil
	}
	expression := arg[2 : len(arg)-1]
	val, err := eval.Eval(expression, vars)
	if err != nil {
		return "", err
	}
	if s, ok := val.(string); ok {
		return s, nil
	}
	return fmt.Sprint(val), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// limitedWriter begrenzt, wie viel Stdout/Stderr eines Script-Schritts
// im Speicher gehalten wird — ein außer Kontrolle geratener Prozess
// (Endlosschleife mit Logging) darf den Orchestrator nicht durch
// unbegrenztes Puffer-Wachstum gefährden. Überschüssige Bytes werden
// stillschweigend verworfen (der Prozess selbst läuft unbeeinflusst
// weiter/wird per Timeout beendet, s. TimeoutSeconds) — kein Fehler,
// nur eine Kappung der PROTOKOLLIERUNG.
type limitedWriter struct {
	w   io.Writer
	max int
	n   int
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	if lw.n < lw.max {
		remaining := lw.max - lw.n
		chunk := p
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		written, err := lw.w.Write(chunk)
		lw.n += written
		if err != nil {
			return written, err
		}
	}
	// Immer die VOLLE Länge von p melden (io.Writer-Vertrag) — der
	// Prozess selbst darf durch die Kappung nicht mit einem I/O-Fehler
	// abbrechen, nur die Mitschrift wird gekappt.
	return len(p), nil
}

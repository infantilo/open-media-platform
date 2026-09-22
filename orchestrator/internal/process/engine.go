// Runtime der Prozess-Engine (Kapitel 21 Phase 3 Teil 1, UMSETZUNG.md
// §6b/21.3 A2/A3/A4/A8-Teilmenge): execution/state machine/retry/
// timeout/recovery/idempotency, wie von der Aufgabenstellung für
// Phase 3 verlangt.
//
// Bewusst NICHT Teil dieser Runde (s. executors.go für die
// Begründungen je Typ): Condition/Branch-Auswertung über eine
// Expression Language (A5, braucht eine neue, sicher sandboxte
// Abhängigkeit — eigene Sitzung), Loop (Abbruchbedingung braucht
// ebenfalls A5), EventTrigger als Schritt-Typ (A8s Zuverlässigkeits-
// Frage — JetStream vs. Postgres-Outbox — ist laut Kapitel-21-Phase-1-
// Analyse noch offen, ein fire-and-forget-EventTrigger wäre eine
// stille Korrektheitslücke), Task/MediaFunction/ServiceCall/Script
// (echte externe Integration, Phase 4). "workflow -> event" (A8, die
// andere Richtung: die Engine BENACHRICHTIGT über eigene
// Zustandsänderungen) ist dagegen umgesetzt — bewusst mit derselben
// fire-and-forget-Ehrlichkeit wie der Rest von internal/eventbus, kein
// Zustellversprechen.
package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// DefaultPollInterval ist die Wartezeit zwischen zwei Zyklen, wenn eine
// Execution gerade auf etwas Externes wartet (Human-Task-Entscheidung,
// Kind-Execution, Kompensations-Fortschritt) — bewusst Polling statt
// Push/Signal: jeder Zustand lebt ausschließlich in Postgres (s.
// computeFrontier), ein Polling-Zyklus braucht daher keinerlei
// In-Memory-Kopplung zwischen dem Auslöser (z. B. CompleteHumanTask)
// und dem wartenden run()-Goroutine — überlebt einen Neustart automatisch
// über RecoverAll, ohne eigenen Wiederanknüpfungs-Mechanismus. Kosten:
// bis zu einem Intervall Verzögerung nach einem externen Ereignis
// (Correctness/Reliability vor Performance, wie an anderer Stelle im
// Projekt priorisiert).
const DefaultPollInterval = 2 * time.Second

// Engine treibt ProcessExecutions durch ihren Schritt-Graphen. Ein
// Engine-Wert ist an einen Store (und damit eine Datenbank) gebunden;
// mehrere Orchestrator-Instanzen dürfen denselben Store mit je einer
// eigenen Engine ansprechen — jede Zustandsänderung ist per CAS
// (row_version) serialisiert, ein doppelt bearbeiteter Schritt
// scheitert für den langsameren Aufrufer sauber mit
// ErrConcurrentModification statt Daten zu verlieren.
type Engine struct {
	store        *Store
	executors    map[StepType]StepExecutor
	events       EventPublisher
	pollInterval time.Duration

	mu          sync.Mutex
	cancelFuncs map[string]context.CancelFunc
	wg          sync.WaitGroup
}

// EngineOption konfiguriert eine neue Engine.
type EngineOption func(*Engine)

// WithPollInterval überschreibt DefaultPollInterval — vor allem für
// Tests gedacht (kurzes Intervall, schnelle Läufe).
func WithPollInterval(d time.Duration) EngineOption {
	return func(e *Engine) { e.pollInterval = d }
}

// WithEventPublisher setzt den Bus für "workflow -> event"
// (Notification-Schritte, A8) sowie Ausführungs-Endzustands-Events.
// Ohne diese Option bleibt der Publisher nil — betroffene Aktionen
// werden dann übersprungen (mit Warnung geloggt), nicht simuliert.
func WithEventPublisher(p EventPublisher) EngineOption {
	return func(e *Engine) { e.events = p }
}

// NewEngine erstellt eine Engine gegen den gegebenen, bereits
// migrierten Store. Registriert die eingebauten, rein strukturellen
// Executors (Wait/Timer/Parallel/Join/HumanTask/Approval/Subworkflow/
// Notification) — Aufrufer können mit Register() weitere Typen
// (Task/MediaFunction/… , Phase 4) ergänzen oder eingebaute Executors
// gezielt überschreiben (z. B. für Tests).
func NewEngine(store *Store, opts ...EngineOption) *Engine {
	e := &Engine{
		store:        store,
		executors:    make(map[StepType]StepExecutor),
		pollInterval: DefaultPollInterval,
		cancelFuncs:  make(map[string]context.CancelFunc),
	}
	for _, opt := range opts {
		opt(e)
	}

	e.executors[StepTypeWait] = StepExecutorFunc(waitExecutor)
	e.executors[StepTypeTimer] = StepExecutorFunc(waitExecutor)
	e.executors[StepTypeParallel] = StepExecutorFunc(passthroughExecutor)
	e.executors[StepTypeJoin] = StepExecutorFunc(passthroughExecutor)
	e.executors[StepTypeHumanTask] = newHumanTaskExecutor(store)
	e.executors[StepTypeApproval] = newHumanTaskExecutor(store)
	e.executors[StepTypeSubworkflow] = newSubworkflowExecutor(store, e.drive)
	e.executors[StepTypeNotification] = newNotificationExecutor(e.events)

	return e
}

// Register bindet einen StepExecutor an einen StepType — überschreibt
// eine eingebaute Registrierung, falls vorhanden. Grundlage für Phase 4
// (Task/MediaFunction/ServiceCall/Script) und Phase 3 Teil 2
// (Condition/Branch, sobald A5 steht).
func (e *Engine) Register(t StepType, ex StepExecutor) {
	e.executors[t] = ex
}

// Start legt eine neue ProcessExecution an (muss auf eine
// VERÖFFENTLICHTE ProcessVersion verweisen, A7) und stößt ihre
// Ausführung an.
func (e *Engine) Start(params CreateExecutionParams) (ProcessExecution, error) {
	version, err := e.store.GetVersion(params.ProcessVersionID)
	if err != nil {
		return ProcessExecution{}, err
	}
	if version.Status != VersionStatusPublished {
		return ProcessExecution{}, fmt.Errorf("process: version %s is not published (status=%s)", version.ID, version.Status)
	}
	exec, err := e.store.CreateExecution(params)
	if err != nil {
		return ProcessExecution{}, err
	}
	e.drive(exec.ID)
	return exec, nil
}

// Cancel bricht eine Execution ab — der treibende Zyklus (falls gerade
// aktiv) wird zusätzlich per Kontext-Abbruch sofort unterbrochen (nicht
// erst am Ende des laufenden Polling-Intervalls), s. drive().
func (e *Engine) Cancel(executionID string) (ProcessExecution, error) {
	exec, err := e.store.GetExecution(executionID)
	if err != nil {
		return ProcessExecution{}, err
	}
	updated, err := e.store.UpdateExecutionStatus(exec.ID, exec.RowVersion, StatusCancelled, "cancelled")
	if err != nil {
		return ProcessExecution{}, err
	}
	e.interrupt(executionID)
	return updated, nil
}

// Pause pausiert eine Execution — der treibende Zyklus beendet sich
// beim nächsten Blick auf den Status von selbst (s. run()); Resume()
// stößt bei Bedarf einen neuen Zyklus an.
func (e *Engine) Pause(executionID string) (ProcessExecution, error) {
	exec, err := e.store.GetExecution(executionID)
	if err != nil {
		return ProcessExecution{}, err
	}
	return e.store.UpdateExecutionStatus(exec.ID, exec.RowVersion, StatusPaused, "")
}

// Resume setzt eine pausierte Execution fort.
func (e *Engine) Resume(executionID string) (ProcessExecution, error) {
	exec, err := e.store.GetExecution(executionID)
	if err != nil {
		return ProcessExecution{}, err
	}
	updated, err := e.store.UpdateExecutionStatus(exec.ID, exec.RowVersion, StatusRunning, "")
	if err != nil {
		return ProcessExecution{}, err
	}
	e.drive(updated.ID)
	return updated, nil
}

// CompleteHumanTask löst die Entscheidung eines HumanTask/Approval-
// Schritts auf — reiner Zustandsschreiber (Store.UpdateHumanTaskStatus),
// KEIN direktes Anstoßen des wartenden Zyklus nötig: der nächste
// Poll-Durchlauf (spätestens nach pollInterval, oder sofort falls die
// Execution gerade neu geladen wird) sieht den terminalen HumanTask-
// Status von selbst (s. humanTaskExecutor). Das macht diese Methode
// unabhängig davon, ob überhaupt gerade ein Goroutine für die
// betroffene Execution aktiv ist (z. B. nach einem Neustart, bevor
// RecoverAll gelaufen ist) — der nächste RecoverAll/Start holt den
// Fortschritt zuverlässig nach.
func (e *Engine) CompleteHumanTask(humanTaskID string, expectedRowVersion int, status, decision, comment string) (HumanTask, error) {
	return e.store.UpdateHumanTaskStatus(humanTaskID, expectedRowVersion, status, decision, comment)
}

// RecoverAll sucht alle nicht-terminalen Executions (pending/running/
// waiting/paused/compensating) und stößt für jede einen treibenden
// Zyklus an — der Wiederanlauf-Baustein für B16: "Start workflow ->
// kill process -> restart -> workflow continues correctly". Gehört an
// den Anfang der Orchestrator-Startsequenz (main.go, Phase 5 —
// außerhalb dieser Runde, s. Moduldoku).
func (e *Engine) RecoverAll() error {
	for _, status := range []string{StatusPending, StatusRunning, StatusWaiting, StatusPaused, StatusCompensating} {
		execs, err := e.store.ListExecutions(ExecutionFilter{Status: status})
		if err != nil {
			return fmt.Errorf("process: recover: list %s executions: %w", status, err)
		}
		for _, exec := range execs {
			e.drive(exec.ID)
		}
	}
	return nil
}

// Shutdown bricht alle aktiven Zyklen ab und wartet, bis sie beendet
// sind — für einen sauberen Prozess-Stop (nicht für die B16-
// Crash-Simulation gedacht, die killt hart statt sauber herunterzufahren).
func (e *Engine) Shutdown() {
	e.mu.Lock()
	for _, cancel := range e.cancelFuncs {
		cancel()
	}
	e.mu.Unlock()
	e.wg.Wait()
}

// drive stößt einen treibenden Zyklus für eine Execution an — verwendet
// von Start/Resume/RecoverAll. Jeder Aufruf bekommt einen eigenen,
// abbrechbaren Kontext (Cancel()/Shutdown() greifen darüber).
func (e *Engine) drive(executionID string) {
	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancelFuncs[executionID] = cancel
	e.mu.Unlock()

	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		defer func() {
			e.mu.Lock()
			delete(e.cancelFuncs, executionID)
			e.mu.Unlock()
			cancel()
		}()
		e.run(ctx, executionID)
	}()
}

// interrupt bricht — falls vorhanden — den aktiven Kontext einer
// Execution sofort ab (Cancel()).
func (e *Engine) interrupt(executionID string) {
	e.mu.Lock()
	cancel, ok := e.cancelFuncs[executionID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

// run ist der treibende Zyklus einer einzelnen Execution — liest ihren
// Zustand IMMER frisch aus der DB (nie aus In-Memory-Zustand), damit
// derselbe Code sowohl einen frischen Start als auch einen nach einem
// Neustart wiederaufgenommenen Lauf korrekt behandelt (kein separater
// Recovery-Algorithmus nötig).
func (e *Engine) run(ctx context.Context, executionID string) {
	// Absicherung gegen einen Programmierfehler in einem Drittanbieter-
	// StepExecutor (Phase 4): ein Panic dort darf nicht den ganzen
	// Orchestrator-Prozess mitreißen, nur den treibenden Zyklus dieser
	// einen Execution beenden (sichtbar geloggt, nicht stillschweigend
	// verschluckt).
	defer func() {
		if r := recover(); r != nil {
			slog.Error("process: engine: run panic recovered", "execution", executionID, "panic", r)
		}
	}()
	for {
		if ctx.Err() != nil {
			return
		}

		exec, err := e.store.GetExecution(executionID)
		if err != nil {
			slog.Error("process: engine: load execution failed", "execution", executionID, "error", err)
			return
		}

		switch exec.Status {
		case StatusCompleted, StatusFailed, StatusCancelled, StatusCompensated:
			return
		case StatusPaused:
			return
		case StatusPending:
			updated, err := e.store.UpdateExecutionStatus(exec.ID, exec.RowVersion, StatusRunning, "")
			if err != nil {
				if errors.Is(err, ErrConcurrentModification) {
					continue
				}
				slog.Error("process: engine: transition to running failed", "execution", executionID, "error", err)
				return
			}
			exec = updated
		case StatusCompensating:
			e.driveCompensation(ctx, exec)
			continue
		}
		// exec.Status ist jetzt "running" oder "waiting".

		version, err := e.store.GetVersion(exec.ProcessVersionID)
		if err != nil {
			slog.Error("process: engine: load version failed", "execution", executionID, "error", err)
			return
		}

		stepExecs, err := e.store.ListStepExecutions(exec.ID)
		if err != nil {
			slog.Error("process: engine: list step executions failed", "execution", executionID, "error", err)
			return
		}
		byID := make(map[string]ProcessStepExecution, len(stepExecs))
		for _, se := range stepExecs {
			byID[se.StepID] = se
		}

		frontier := computeFrontier(version.Definition, byID)
		if len(frontier) == 0 {
			done, err := e.finalize(exec, byID, version.Definition)
			if err != nil {
				slog.Error("process: engine: finalize failed", "execution", executionID, "error", err)
				return
			}
			if done {
				return
			}
			e.sleep(ctx, e.pollInterval)
			continue
		}

		var wg sync.WaitGroup
		for _, step := range frontier {
			step := step
			wg.Add(1)
			go func() {
				defer wg.Done()
				e.runStep(ctx, exec, step, byID)
			}()
		}
		wg.Wait()
	}
}

// driveCompensation sucht den fehlgeschlagenen Schritt, dessen
// CompensationStepID den Kompensationspfad bestimmt (Teil 1: genau ein
// Kompensationsschritt je Execution — Mehrfach-Kompensation über
// mehrere fehlgeschlagene Zweige hinweg wäre echte Zusatzkomplexität
// ohne aktuellen Bedarf, YAGNI), und treibt ihn über dieselbe
// runStep-Maschinerie wie jeden anderen Schritt (Retry/Timeout gelten
// unverändert auch für Kompensationsschritte).
func (e *Engine) driveCompensation(ctx context.Context, exec ProcessExecution) {
	version, err := e.store.GetVersion(exec.ProcessVersionID)
	if err != nil {
		slog.Error("process: engine: compensation: load version failed", "execution", exec.ID, "error", err)
		return
	}
	stepExecs, err := e.store.ListStepExecutions(exec.ID)
	if err != nil {
		slog.Error("process: engine: compensation: list step executions failed", "execution", exec.ID, "error", err)
		return
	}
	stepByID := make(map[string]Step, len(version.Definition.Steps))
	for _, s := range version.Definition.Steps {
		stepByID[s.ID] = s
	}
	byID := make(map[string]ProcessStepExecution, len(stepExecs))
	for _, se := range stepExecs {
		byID[se.StepID] = se
	}

	var compStep *Step
	for _, se := range stepExecs {
		if se.Status != StatusFailed && se.Status != StatusTimedOut {
			continue
		}
		s, ok := stepByID[se.StepID]
		if !ok || s.CompensationStepID == "" {
			continue
		}
		target, ok := stepByID[s.CompensationStepID]
		if !ok {
			continue
		}
		compStep = &target
		break
	}

	if compStep == nil {
		latest, err := e.store.GetExecution(exec.ID)
		if err != nil {
			slog.Error("process: engine: compensation: reload execution failed", "execution", exec.ID, "error", err)
			return
		}
		if _, err := e.store.UpdateExecutionStatus(latest.ID, latest.RowVersion, StatusFailed, "compensation: no compensating step found"); err != nil {
			// ErrConcurrentModification bedeutet HIER NICHT "jemand
			// anderes hat es bereits erledigt" (anders als beim üblichen
			// CAS-Muster) — es gibt keinen zweiten Schreiber, der
			// denselben Zielzustand anstrebt. Ein Event auf Verdacht zu
			// publizieren wäre ein unbewiesener Erfolg (echter, per
			// Race-Test gefundener Fehler einer früheren Fassung: dieser
			// Zweig ignorierte ErrConcurrentModification und publizierte
			// trotzdem "failed", obwohl der Schreibversuch selbst
			// gescheitert war) — stattdessen einfach zurückkehren, der
			// nächste Poll-Zyklus liest den tatsächlichen Stand neu und
			// entscheidet auf dessen Basis korrekt.
			if !errors.Is(err, ErrConcurrentModification) {
				slog.Error("process: engine: compensation: mark failed error", "execution", exec.ID, "error", err)
			}
			return
		}
		e.publishExecutionEvent(exec.ID, StatusFailed)
		return
	}

	e.runStep(ctx, exec, *compStep, byID)

	compSE, err := e.store.GetOrCreateStepExecution(exec.ID, compStep.ID, compStep.Type, nil)
	if err != nil {
		slog.Error("process: engine: compensation: reload step execution failed", "execution", exec.ID, "error", err)
		return
	}
	latest, err := e.store.GetExecution(exec.ID)
	if err != nil {
		slog.Error("process: engine: compensation: reload execution failed", "execution", exec.ID, "error", err)
		return
	}

	// ErrConcurrentModification wird in diesem switch NICHT stillschweigend
	// als Erfolg behandelt (anders als das übliche CAS-Muster, wo ein
	// zweiter Schreiber denselben Zielzustand anstrebt): es gibt hier
	// keinen zweiten legitimen Schreiber, der "compensated"/"failed"
	// bereits gesetzt haben könnte. Ein Event auf Verdacht zu publizieren,
	// obwohl der eigene Schreibversuch scheiterte, wäre ein unbewiesener
	// Erfolg (echter, per Race-Test gefundener Fehler einer früheren
	// Fassung). Bei jedem Fehler (auch ErrConcurrentModification) einfach
	// zurückkehren — der nächste Poll-Zyklus liest den tatsächlichen
	// DB-Stand neu (compSE.Status bleibt "completed"/"failed", also
	// idempotent erneut versuchbar) und publiziert das Event erst nach
	// einem TATSÄCHLICH erfolgreichen Schreibvorgang.
	switch compSE.Status {
	case StatusCompleted:
		if _, err := e.store.UpdateExecutionStatus(latest.ID, latest.RowVersion, StatusCompensated, ""); err != nil {
			if !errors.Is(err, ErrConcurrentModification) {
				slog.Error("process: engine: compensation: mark compensated error", "execution", exec.ID, "error", err)
			}
			return
		}
		e.publishExecutionEvent(exec.ID, StatusCompensated)
	case StatusFailed, StatusTimedOut:
		if _, err := e.store.UpdateExecutionStatus(latest.ID, latest.RowVersion, StatusFailed, "compensation failed: "+compSE.Error); err != nil {
			if !errors.Is(err, ErrConcurrentModification) {
				slog.Error("process: engine: compensation: mark failed error", "execution", exec.ID, "error", err)
			}
			return
		}
		e.publishExecutionEvent(exec.ID, StatusFailed)
	default:
		e.sleep(ctx, e.pollInterval)
	}
}

// finalize wird aufgerufen, sobald computeFrontier nichts mehr Eligibles
// findet — entscheidet, ob die Execution wirklich fertig ist
// (COMPLETED), fehlgeschlagen ist (FAILED, ggf. gefolgt von
// COMPENSATING) oder ob es sich um einen erwarteten Zwischenzustand
// handelt (sollte laut Frontier-Konstruktion nicht vorkommen, s. u.).
// done=true bedeutet "run() kann sich beenden", done=false bedeutet
// "beim nächsten Zyklus erneut prüfen" (z. B. weil gerade erst auf
// COMPENSATING umgeschaltet wurde).
func (e *Engine) finalize(exec ProcessExecution, byID map[string]ProcessStepExecution, def Definition) (bool, error) {
	if len(byID) == 0 {
		return false, fmt.Errorf("process: execution %s: finalize called with no started steps", exec.ID)
	}

	var failed *ProcessStepExecution
	allCompleted := true
	for _, se := range byID {
		switch se.Status {
		case StatusCompleted:
		case StatusFailed, StatusTimedOut, StatusCancelled:
			allCompleted = false
			if failed == nil {
				f := se
				failed = &f
			}
		default:
			// pending/running/waiting: computeFrontier hätte diesen
			// Schritt sonst in die Frontier aufgenommen — defensiv
			// abwarten statt fälschlich zu finalisieren (sollte praktisch
			// nie eintreten, s. engine_test.go für den Beweis per Test).
			return false, nil
		}
	}

	// ErrConcurrentModification wird ab hier NICHT als fataler Fehler
	// behandelt (echter, per Race-Test gefundener Fehler einer früheren
	// Fassung: ein CAS-Konflikt an dieser Stelle ließ den gesamten
	// treibenden Goroutine mit `slog.Error` + `return` sterben — die
	// Execution blieb dauerhaft im vorherigen Status stecken, NIEMAND
	// versuchte es je wieder, weil kein weiterer Aufrufer existiert, der
	// einen bereits beendeten run()-Zyklus erneut anstößt). Stattdessen:
	// (false, nil) zurückgeben — der äußere Zyklus (run()) liest beim
	// nächsten Durchlauf den TATSÄCHLICHEN DB-Stand neu und entscheidet
	// auf dessen Basis korrekt weiter, ganz gleich, was den Konflikt
	// verursacht hat.
	if allCompleted {
		// Reihenfolge bewusst Output-ZUERST, Status-DANACH: ein anderer
		// Aufrufer (z. B. der Subworkflow-Executor der Eltern-Execution,
		// s. executors.go) liest Status und Output über zwei getrennte
		// GetExecution()-Aufrufe, nie in einer einzigen atomaren
		// Transaktion. Stünde der Status schon auf "completed", während
		// Output noch das leere Default ist, könnte ein Poll genau in
		// diese Lücke fallen und fälschlich ein leeres Ergebnis als
		// endgültig übernehmen (echter, per Test gefundener Fehler einer
		// früheren Fassung: TestEngineSubworkflowWaitsForChildCompletion
		// sah gelegentlich `{}` statt des echten Kind-Outputs). Mit
		// Output zuerst ist "Status ist bereits completed" IMMER
		// gleichbedeutend mit "Output ist bereits der echte Wert".
		output := computeExecutionOutput(def, byID)
		withOutput, err := e.store.SetExecutionOutput(exec.ID, exec.RowVersion, output)
		if err != nil {
			if errors.Is(err, ErrConcurrentModification) {
				return false, nil
			}
			return false, err
		}
		updated, err := e.store.UpdateExecutionStatus(withOutput.ID, withOutput.RowVersion, StatusCompleted, "")
		if err != nil {
			if errors.Is(err, ErrConcurrentModification) {
				return false, nil
			}
			return false, err
		}
		e.publishExecutionEvent(updated.ID, StatusCompleted)
		return true, nil
	}

	stepByID := make(map[string]Step, len(def.Steps))
	for _, s := range def.Steps {
		stepByID[s.ID] = s
	}
	failing, err := e.store.UpdateExecutionStatus(exec.ID, exec.RowVersion, StatusFailed, failed.Error)
	if err != nil {
		if errors.Is(err, ErrConcurrentModification) {
			return false, nil
		}
		return false, err
	}
	if s, ok := stepByID[failed.StepID]; ok && s.CompensationStepID != "" {
		// Dieser Übergang drückt eine DEFINITIVE Absicht aus (Kompensation
		// ist gerade erst als nötig erkannt worden) — ein einzelner
		// CAS-Konflikt darf sie nicht stillschweigend fallen lassen (die
		// Execution bliebe sonst für immer bei "failed" hängen, obwohl
		// eine Kompensation existiert und laufen sollte). Deshalb hier,
		// anders als bei den übrigen Store-Aufrufen in dieser Datei, ein
		// kurzer Retry-Loop mit frisch gelesenem row_version statt eines
		// einzelnen Versuchs.
		current := failing
		var err error
		const maxAttempts = 10
		for attempt := 0; attempt < maxAttempts; attempt++ {
			if attempt > 0 {
				// Kleine Pause vor jedem Wiederholungsversuch (außer dem
				// ersten) — falls die Ursache eine kurzlebige
				// Sichtbarkeitsverzögerung ist (z. B. zwischen zwei
				// verschiedenen Pool-Verbindungen), gibt das ihr Zeit,
				// sich aufzulösen, statt sofort erneut denselben
				// veralteten Stand zu lesen.
				time.Sleep(5 * time.Millisecond)
			}
			_, err = e.store.UpdateExecutionStatus(current.ID, current.RowVersion, StatusCompensating, failed.Error)
			if err == nil {
				return false, nil
			}
			if !errors.Is(err, ErrConcurrentModification) {
				return false, err
			}
			current, err = e.store.GetExecution(exec.ID)
			if err != nil {
				return false, err
			}
			if current.Status != StatusFailed {
				// Ein anderer Aufrufer hat den Status bereits verändert
				// (z. B. ein Cancel) — kein Grund mehr, selbst auf
				// "compensating" zu bestehen.
				return false, nil
			}
		}
		slog.Error("process: engine: could not transition to compensating after retries, giving up", "execution", exec.ID, "attempts", maxAttempts, "error", err)
		return false, fmt.Errorf("process: execution %s: could not transition to compensating after retries: %w", exec.ID, err)
	}
	e.publishExecutionEvent(failing.ID, StatusFailed)
	return true, nil
}

// runStep führt EINEN Schritt bis zu seinem nächsten sichtbaren
// Zwischen- oder Endzustand aus — inklusive der kompletten Retry-/
// Backoff-Schleife (A4) SYNCHRON innerhalb dieses einen Aufrufs: ein
// fehlgeschlagener, noch nicht erschöpfter Versuch bleibt dabei
// durchgehend im Status "running" (RecordAttemptAndContinue statt
// eines Zwischenstopps bei "failed") — ein Crash mitten in der
// Backoff-Pause lässt den Schritt beim Wiederanlauf deshalb korrekt als
// "noch in Bearbeitung" erscheinen, nicht als fälschlich endgültig
// gescheitert (B16). Timeout (A4) wrapped den Executor-Aufruf in einen
// Kontext mit Deadline; ein Timeout zählt als fehlgeschlagener Versuch
// mit eigenem Zielstatus (TIMED_OUT statt FAILED bei Erschöpfung).
func (e *Engine) runStep(ctx context.Context, exec ProcessExecution, step Step, byID map[string]ProcessStepExecution) {
	se, err := e.store.GetOrCreateStepExecution(exec.ID, step.ID, step.Type, nil)
	if err != nil {
		slog.Error("process: engine: get-or-create step execution failed", "execution", exec.ID, "step", step.ID, "error", err)
		return
	}

	for {
		if ctx.Err() != nil {
			return
		}

		switch se.Status {
		case StatusCompleted, StatusFailed, StatusCancelled, StatusTimedOut, StatusCompensated:
			return
		case StatusPending:
			updated, err := e.store.UpdateStepExecutionStatus(se.ID, se.RowVersion, StatusRunning, "")
			if err != nil {
				if errors.Is(err, ErrConcurrentModification) {
					reloaded, rerr := e.store.GetStepExecution(se.ID)
					if rerr != nil {
						slog.Error("process: engine: reload step execution failed", "step", se.ID, "error", rerr)
						return
					}
					se = reloaded
					continue
				}
				slog.Error("process: engine: transition step to running failed", "step", se.ID, "error", err)
				return
			}
			se = updated
		}
		// se.Status ist jetzt "running" oder "waiting" (aus einem
		// früheren Poll-Zyklus).

		executor, ok := e.executors[step.Type]
		if !ok {
			if _, err := e.store.UpdateStepExecutionStatus(se.ID, se.RowVersion, StatusFailed, ErrNoExecutorRegistered.Error()); err != nil && !errors.Is(err, ErrConcurrentModification) {
				slog.Error("process: engine: mark step failed (no executor) error", "step", se.ID, "error", err)
			}
			return
		}

		stepCtx := ctx
		var cancel context.CancelFunc
		if step.TimeoutSeconds > 0 {
			stepCtx, cancel = context.WithTimeout(ctx, time.Duration(step.TimeoutSeconds)*time.Second)
		}
		ec := ExecutionCtx{Execution: exec, StepExec: se, Outputs: collectOutputs(byID)}
		output, execErr := executor.Execute(stepCtx, ec, step)
		timedOut := cancel != nil && errors.Is(stepCtx.Err(), context.DeadlineExceeded)
		if cancel != nil {
			cancel()
		}

		switch {
		case execErr == nil:
			updated, err := e.store.UpdateStepExecutionStatus(se.ID, se.RowVersion, StatusCompleted, "")
			if err != nil {
				if !errors.Is(err, ErrConcurrentModification) {
					slog.Error("process: engine: mark step completed error", "step", se.ID, "error", err)
				}
				return
			}
			if _, err := e.store.SetStepExecutionOutput(updated.ID, updated.RowVersion, output); err != nil {
				slog.Error("process: engine: set step output error", "step", se.ID, "error", err)
			}
			return

		case errors.Is(execErr, ErrStepWaiting):
			if se.Status != StatusWaiting {
				if _, err := e.store.UpdateStepExecutionStatus(se.ID, se.RowVersion, StatusWaiting, ""); err != nil && !errors.Is(err, ErrConcurrentModification) {
					slog.Error("process: engine: mark step waiting error", "step", se.ID, "error", err)
				}
			}
			return

		default:
			errMsg := execErr.Error()
			terminalStatus := StatusFailed
			if timedOut {
				terminalStatus = StatusTimedOut
				errMsg = "timeout"
			}

			if step.Retry != nil && se.Attempt < step.Retry.MaxAttempts {
				retried, err := e.store.RecordAttemptAndContinue(se.ID, se.RowVersion, errMsg)
				if err != nil {
					if !errors.Is(err, ErrConcurrentModification) {
						slog.Warn("process: engine: record retry attempt failed", "step", se.ID, "error", err)
					}
					return
				}
				delay := computeBackoff(step.Retry, retried.Attempt)
				e.sleep(ctx, delay)
				se = retried
				continue
			}

			if _, err := e.store.UpdateStepExecutionStatus(se.ID, se.RowVersion, terminalStatus, errMsg); err != nil && !errors.Is(err, ErrConcurrentModification) {
				slog.Error("process: engine: mark step failed error", "step", se.ID, "error", err)
			}
			return
		}
	}
}

// sleep wartet d oder bis ctx endet — je nachdem, was zuerst eintritt.
func (e *Engine) sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

// publishExecutionEvent meldet einen Ausführungs-Endzustand über den
// optionalen EventPublisher (A8 "workflow -> event", B15) — fire-and-
// forget wie der Rest von internal/eventbus, s. Moduldoku oben.
func (e *Engine) publishExecutionEvent(executionID, status string) {
	if e.events == nil {
		return
	}
	subject := fmt.Sprintf("omp.process.%s.%s", executionID, status)
	if err := e.events.Publish(subject, []byte(`{}`)); err != nil {
		slog.Warn("process: engine: publish execution event failed", "execution", executionID, "status", status, "error", err)
	}
}

// collectOutputs liefert die Outputs bereits abgeschlossener Schritte
// (stepID -> Output) als ExecutionCtx.Outputs-Snapshot für die aktuell
// laufende Welle — Geschwister derselben Welle sehen einander bewusst
// NICHT (sie sind laut Graph-Konstruktion nicht voneinander abhängig,
// s. computeFrontier).
func collectOutputs(byID map[string]ProcessStepExecution) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(byID))
	for stepID, se := range byID {
		if se.Status == StatusCompleted {
			out[stepID] = se.Output
		}
	}
	return out
}

// computeExecutionOutput bestimmt das Gesamtergebnis einer erfolgreich
// abgeschlossenen Execution (A2: ProcessExecution.Output) — die Outputs
// aller "Sink"-Schritte (kein Next, keine Branches: Definition-Enden).
// Genau ein abgeschlossener Sink -> dessen Output direkt übernehmen
// (der häufige Fall, z. B. ein einzelner Subworkflow-Aufruf-Schritt);
// mehrere Sinks -> als stepID->Output-Objekt zusammengefasst, damit
// kein Ergebnis stillschweigend verworfen wird.
func computeExecutionOutput(def Definition, byID map[string]ProcessStepExecution) json.RawMessage {
	var completedSinks []string
	for _, s := range def.Steps {
		if len(s.Next) != 0 || len(s.Branches) != 0 {
			continue
		}
		if se, ok := byID[s.ID]; ok && se.Status == StatusCompleted {
			completedSinks = append(completedSinks, s.ID)
		}
	}
	if len(completedSinks) == 1 {
		return byID[completedSinks[0]].Output
	}
	agg := make(map[string]json.RawMessage, len(completedSinks))
	for _, id := range completedSinks {
		agg[id] = byID[id].Output
	}
	raw, err := json.Marshal(agg)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return raw
}

// ---- Graph-Auswertung -----------------------------------------------

// buildPredecessors liefert für jeden Schritt seine Vorgänger — sowohl
// über Next (unbedingter Fan-out/AND-Join) als auch über Branches
// (bedingter, sich gegenseitig ausschließender Fan-out — nur EIN
// Branches-Ziel wird pro Ausführung tatsächlich "aktiviert", s.
// resolveSuccessors/computeFrontier). CompensationStepID zählt bewusst
// NICHT als Vorgänger-Kante (gleiche Begründung wie in validate.go: ein
// Kompensationsschritt wird nur über den separaten Fehlerpfad
// angesprungen, nie über den regulären Graph-Durchlauf).
func buildPredecessors(d Definition) map[string][]string {
	preds := make(map[string][]string)
	for _, s := range d.Steps {
		for _, n := range s.Next {
			preds[n] = append(preds[n], s.ID)
		}
		for _, target := range s.Branches {
			preds[target] = append(preds[target], s.ID)
		}
	}
	return preds
}

// resolveSuccessors bestimmt, welche(r) Folgeschritt(e) nach dem
// erfolgreichen Abschluss eines Schritts aktiviert werden. Hat der
// Schritt Branches, entscheidet ein aus dem Output extrahiertes
// "decision"-Feld (von den eingebauten HumanTask/Approval-Executors
// gefüllt, s. executors.go) über GENAU EIN Ziel — findet sich kein
// passender Eintrag, wird KEIN Folgeschritt aktiviert (die übrigen
// Branches-Ziele bleiben für immer inaktiv, kein Fehler: das ist die
// beabsichtigte XOR-Semantik einer nicht gewählten Alternative). Ohne
// Branches gilt der unbedingte Next-Fan-out.
func resolveSuccessors(step Step, output json.RawMessage) []string {
	if len(step.Branches) > 0 {
		decision := extractDecision(output)
		if target, ok := step.Branches[decision]; ok {
			return []string{target}
		}
		return nil
	}
	return step.Next
}

// extractDecision liest ein optionales "decision"-Feld aus einem
// Schritt-Output — genutzt für Branches-Auflösung (s. resolveSuccessors).
// Ein Output ohne dieses Feld liefert einen leeren String (kein Fehler).
func extractDecision(output json.RawMessage) string {
	if len(output) == 0 {
		return ""
	}
	var v struct {
		Decision string `json:"decision"`
	}
	_ = json.Unmarshal(output, &v)
	return v.Decision
}

// computeFrontier liefert alle Schritte, die JETZT bearbeitet werden
// müssen — entweder weil sie bereits einen nicht-terminalen Lauf haben
// (pending/running/waiting, z. B. nach einem Neustart) oder weil sie
// neu aktiviert wurden: der Startschritt, oder ein Schritt, dessen
// Vorgänger ALLE einen terminalen Lauf haben UND von denen mindestens
// einer ihn tatsächlich als Folgeschritt gewählt hat (s.
// resolveSuccessors — deckt sowohl echtes AND-Join über Next als auch
// XOR-Branches über Branches korrekt ab, ohne die beiden Fälle im Code
// zu unterscheiden).
func computeFrontier(def Definition, byID map[string]ProcessStepExecution) []Step {
	preds := buildPredecessors(def)
	stepByID := make(map[string]Step, len(def.Steps))
	for _, s := range def.Steps {
		stepByID[s.ID] = s
	}

	var frontier []Step
	for _, s := range def.Steps {
		se, started := byID[s.ID]
		if started {
			switch se.Status {
			case StatusPending, StatusRunning, StatusWaiting:
				frontier = append(frontier, s)
			}
			continue
		}
		if s.ID == def.StartStepID {
			frontier = append(frontier, s)
			continue
		}

		ps := preds[s.ID]
		if len(ps) == 0 {
			// Unerreichbar — Definition.Validate() sollte das bereits
			// verhindert haben; defensiv einfach überspringen statt zu
			// blockieren.
			continue
		}

		allTerminal := true
		activated := false
		for _, p := range ps {
			pse, ok := byID[p]
			if !ok || !isRunEndStatus(pse.Status) {
				allTerminal = false
				break
			}
			if pse.Status != StatusCompleted {
				continue // fehlgeschlagener/abgebrochener Vorgänger aktiviert nie
			}
			for _, succ := range resolveSuccessors(stepByID[p], pse.Output) {
				if succ == s.ID {
					activated = true
					break
				}
			}
		}
		if allTerminal && activated {
			frontier = append(frontier, s)
		}
	}
	return frontier
}

// ---- Retry/Backoff -----------------------------------------------

const (
	defaultInitialDelay = time.Second
	defaultMaxDelay     = 30 * time.Second
)

// computeBackoff berechnet die Wartezeit vor dem gegebenen (bereits
// erhöhten) Versuch — attempt=2 ist die Pause vor dem zweiten Versuch,
// usw. Unbekannte/leere Backoff-Werte gelten als "fixed" (dokumentiert,
// kein stilles Raten zwischen den beiden zulässigen Werten).
func computeBackoff(policy *RetryPolicy, attempt int) time.Duration {
	if policy == nil {
		return 0
	}
	initial := parseDurationDefault(policy.InitialDelay, defaultInitialDelay)
	maxDelay := parseDurationDefault(policy.MaxDelay, defaultMaxDelay)

	var d time.Duration
	switch policy.Backoff {
	case "exponential":
		shift := attempt - 1
		if shift < 0 {
			shift = 0
		}
		if shift > 20 { // Überlauf-Schutz bei sehr hohen MaxAttempts
			shift = 20
		}
		d = initial * time.Duration(int64(1)<<uint(shift))
	default:
		d = initial
	}
	if d <= 0 || d > maxDelay {
		d = maxDelay
	}
	return d
}

func parseDurationDefault(s string, def time.Duration) time.Duration {
	if s == "" {
		return def
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return def
	}
	return d
}

package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testPollInterval ist kurz genug für schnelle Tests, aber lang genug,
// um keine unrealistische Busy-Loop-Last zu erzeugen.
const testPollInterval = 20 * time.Millisecond

func testEngine(t *testing.T, opts ...EngineOption) (*Engine, *Store) {
	t.Helper()
	store := NewStore(testDB(t))
	allOpts := append([]EngineOption{WithPollInterval(testPollInterval)}, opts...)
	engine := NewEngine(store, allOpts...)
	t.Cleanup(engine.Shutdown)
	return engine, store
}

// publishedVersion legt eine Definition an, validiert sie implizit über
// CreateVersion und veröffentlicht sie — Executions dürfen laut A7 nur
// auf veröffentlichte Versionen verweisen.
func publishedVersion(t *testing.T, store *Store, def Definition) (ProcessDefinition, ProcessVersion) {
	t.Helper()
	pd, err := store.CreateDefinition("Test Process", "", "", "tester", "")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}
	v, err := store.CreateVersion(pd.ID, def, "tester")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	v, err = store.PublishVersion(v.ID)
	if err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}
	return pd, v
}

// awaitExecutionStatus pollt, bis die Execution einen der want-Status
// erreicht (oder das Zeitbudget abläuft) — Test-eigenes Polling, unab-
// hängig vom Engine-internen Intervall.
func awaitExecutionStatus(t *testing.T, store *Store, executionID string, timeout time.Duration, want ...string) ProcessExecution {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last ProcessExecution
	for time.Now().Before(deadline) {
		exec, err := store.GetExecution(executionID)
		if err != nil {
			t.Fatalf("GetExecution() error = %v", err)
		}
		last = exec
		for _, w := range want {
			if exec.Status == w {
				return exec
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("execution %s did not reach status %v within %s, last status = %s (error=%q)", executionID, want, timeout, last.Status, last.Error)
	return ProcessExecution{}
}

func awaitHumanTask(t *testing.T, store *Store, stepExecutionID string, timeout time.Duration) HumanTask {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		task, err := store.GetHumanTaskByStepExecution(stepExecutionID)
		if err == nil {
			return task
		}
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("GetHumanTaskByStepExecution() error = %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no human task appeared for step execution %s within %s", stepExecutionID, timeout)
	return HumanTask{}
}

func awaitStepExecution(t *testing.T, store *Store, executionID, stepID string, timeout time.Duration) ProcessStepExecution {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		steps, err := store.ListStepExecutions(executionID)
		if err != nil {
			t.Fatalf("ListStepExecutions() error = %v", err)
		}
		for _, s := range steps {
			if s.StepID == stepID {
				return s
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("step %s never got a step execution within %s", stepID, timeout)
	return ProcessStepExecution{}
}

// ---- einfache lineare Kette -----------------------------------------------

func TestEngineLinearChainCompletes(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "a",
		Steps: []Step{
			{ID: "a", Type: StepTypeTask, Next: []string{"b"}},
			{ID: "b", Type: StepTypeTask},
		},
	})
	// StepTypeTask hat in Teil 1 keinen eingebauten Executor — hier
	// bewusst ein Passthrough registriert, um die reine Graph-
	// Durchlauflogik isoliert vom "kein Executor"-Fall zu testen.
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(fmt.Sprintf(`{"ran":%q}`, step.ID)), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 2 {
		t.Fatalf("ListStepExecutions() = %d rows, want 2", len(steps))
	}
	for _, s := range steps {
		if s.Status != StatusCompleted {
			t.Errorf("step %s status = %s, want completed", s.StepID, s.Status)
		}
	}
}

// ---- kein Executor -----------------------------------------------

func TestEngineNoExecutorRegisteredFailsHonestly(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "a",
		Steps:       []Step{{ID: "a", Type: StepTypeMediaFunction}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (no executor registered for media_function)", final.Status)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 1 || steps[0].Status != StatusFailed || steps[0].Error != ErrNoExecutorRegistered.Error() {
		t.Fatalf("ListStepExecutions() = %+v, want single failed step with ErrNoExecutorRegistered", steps)
	}
}

// TestEngineStartRejectsUnpublishedVersion (Phase 5 Teil 2): die
// HTTP-API verlässt sich auf errors.Is(err, ErrVersionNotPublished), um
// 409 statt 500 zu melden.
func TestEngineStartRejectsUnpublishedVersion(t *testing.T) {
	engine, store := testEngine(t)
	pd, err := store.CreateDefinition("Test Process", "", "", "tester", "")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}
	v, err := store.CreateVersion(pd.ID, Definition{
		StartStepID: "a",
		Steps:       []Step{{ID: "a", Type: StepTypeTask}},
	}, "tester")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}

	_, err = engine.Start(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if !errors.Is(err, ErrVersionNotPublished) {
		t.Fatalf("Start() error = %v, want errors.Is(err, ErrVersionNotPublished) (version is still draft)", err)
	}
}

// ---- Parallel/Join -----------------------------------------------

func TestEngineParallelFanOutJoin(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "start",
		Steps: []Step{
			{ID: "start", Type: StepTypeParallel, Next: []string{"a", "b"}},
			{ID: "a", Type: StepTypeTask, Next: []string{"join"}},
			{ID: "b", Type: StepTypeTask, Next: []string{"join"}},
			{ID: "join", Type: StepTypeJoin},
		},
	})

	var aStarted, bStarted atomic.Bool
	var mu sync.Mutex
	var order []string
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		if step.ID == "a" {
			aStarted.Store(true)
		} else {
			bStarted.Store(true)
		}
		// Kurze Pause, damit beide Zweige nachweislich gleichzeitig laufen
		// (nicht nacheinander) — wenn b erst NACH a's Rückkehr startet,
		// wäre der Fan-out nicht wirklich parallel.
		time.Sleep(50 * time.Millisecond)
		mu.Lock()
		order = append(order, step.ID)
		mu.Unlock()
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 3*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	if !aStarted.Load() || !bStarted.Load() {
		t.Fatalf("both parallel branches should have started, a=%v b=%v", aStarted.Load(), bStarted.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 {
		t.Fatalf("both branches should have completed, order=%v", order)
	}

	joinStep := awaitStepExecution(t, store, exec.ID, "join", time.Second)
	if joinStep.Status != StatusCompleted {
		t.Fatalf("join step status = %s, want completed", joinStep.Status)
	}
}

// ---- Condition/Branch (A5) -----------------------------------------------

func TestEngineConditionRoutesOnExpressionResult(t *testing.T) {
	engine, store := testEngine(t)
	cfg := mustMarshal(t, conditionConfig{Expression: "input.asset.duration > 30", TrueLabel: "valid", FalseLabel: "invalid"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "validate",
		Steps: []Step{
			{ID: "validate", Type: StepTypeCondition, Config: cfg, Branches: map[string]string{
				"valid":   "transcode",
				"invalid": "review",
			}},
			{ID: "transcode", Type: StepTypeTask},
			{ID: "review", Type: StepTypeTask},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{
		ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester",
		Input: json.RawMessage(`{"asset":{"duration":45}}`),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	ran := map[string]bool{}
	for _, s := range steps {
		ran[s.StepID] = true
	}
	if !ran["transcode"] {
		t.Errorf("expected 'transcode' to run (duration 45 > 30 -> valid), steps=%v", ran)
	}
	if ran["review"] {
		t.Errorf("did NOT expect 'review' to run (condition was true), steps=%v", ran)
	}
}

func TestEngineConditionRoutesToFalseBranch(t *testing.T) {
	engine, store := testEngine(t)
	cfg := mustMarshal(t, conditionConfig{Expression: "input.asset.duration > 30", TrueLabel: "valid", FalseLabel: "invalid"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "validate",
		Steps: []Step{
			{ID: "validate", Type: StepTypeCondition, Config: cfg, Branches: map[string]string{
				"valid":   "transcode",
				"invalid": "review",
			}},
			{ID: "transcode", Type: StepTypeTask},
			{ID: "review", Type: StepTypeTask},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{
		ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester",
		Input: json.RawMessage(`{"asset":{"duration":10}}`),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	ran := map[string]bool{}
	for _, s := range steps {
		ran[s.StepID] = true
	}
	if !ran["review"] {
		t.Errorf("expected 'review' to run (duration 10 <= 30 -> invalid), steps=%v", ran)
	}
	if ran["transcode"] {
		t.Errorf("did NOT expect 'transcode' to run (condition was false), steps=%v", ran)
	}
}

func TestEngineConditionInvalidExpressionFailsHonestly(t *testing.T) {
	engine, store := testEngine(t)
	cfg := mustMarshal(t, conditionConfig{Expression: "input.asset.duration >>> 30"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "validate",
		Steps:       []Step{{ID: "validate", Type: StepTypeCondition, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (invalid expression syntax)", final.Status)
	}
}

func TestEngineBranchPicksFirstMatchingCase(t *testing.T) {
	engine, store := testEngine(t)
	cfg := mustMarshal(t, branchConfig{
		Cases: []branchCase{
			{Expression: `outputs.qc.score >= 0.95`, Label: "excellent"},
			{Expression: `outputs.qc.score >= 0.8`, Label: "acceptable"},
		},
		DefaultLabel: "reject",
	})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "qc",
		Steps: []Step{
			{ID: "qc", Type: StepTypeTask, Next: []string{"grade"}},
			{ID: "grade", Type: StepTypeBranch, Config: cfg, Branches: map[string]string{
				"excellent":  "publish",
				"acceptable": "review",
				"reject":     "rework",
			}},
			{ID: "publish", Type: StepTypeTask},
			{ID: "review", Type: StepTypeTask},
			{ID: "rework", Type: StepTypeTask},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		if step.ID == "qc" {
			return json.RawMessage(`{"score":0.88}`), nil
		}
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	ran := map[string]bool{}
	for _, s := range steps {
		ran[s.StepID] = true
	}
	if !ran["review"] {
		t.Errorf("expected 'review' to run (score 0.88 matches 'acceptable', not 'excellent'), steps=%v", ran)
	}
	if ran["publish"] || ran["rework"] {
		t.Errorf("expected exactly one branch target ('review') to run, steps=%v", ran)
	}
}

func TestEngineBranchFallsBackToDefaultLabel(t *testing.T) {
	engine, store := testEngine(t)
	cfg := mustMarshal(t, branchConfig{
		Cases:        []branchCase{{Expression: `outputs.qc.score >= 0.95`, Label: "excellent"}},
		DefaultLabel: "reject",
	})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "qc",
		Steps: []Step{
			{ID: "qc", Type: StepTypeTask, Next: []string{"grade"}},
			{ID: "grade", Type: StepTypeBranch, Config: cfg, Branches: map[string]string{
				"excellent": "publish",
				"reject":    "rework",
			}},
			{ID: "publish", Type: StepTypeTask},
			{ID: "rework", Type: StepTypeTask},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		if step.ID == "qc" {
			return json.RawMessage(`{"score":0.2}`), nil
		}
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	ran := map[string]bool{}
	for _, s := range steps {
		ran[s.StepID] = true
	}
	if !ran["rework"] {
		t.Errorf("expected 'rework' to run (score 0.2 matches no case -> defaultLabel 'reject'), steps=%v", ran)
	}
}

// ---- HumanTask mit entscheidungsbasiertem Branching -----------------------------------------------

func TestEngineHumanTaskWaitsThenRoutesByDecision(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "review",
		Steps: []Step{
			{ID: "review", Type: StepTypeHumanTask, Branches: map[string]string{
				"approve": "publish",
				"reject":  "rework",
			}},
			{ID: "publish", Type: StepTypeTask},
			{ID: "rework", Type: StepTypeTask},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	reviewSE := awaitStepExecution(t, store, exec.ID, "review", time.Second)
	task := awaitHumanTask(t, store, reviewSE.ID, time.Second)
	if task.Status != HumanTaskStatusPending {
		t.Fatalf("human task status = %s, want pending", task.Status)
	}

	// Execution darf jetzt nicht fertig sein — sie wartet auf die
	// menschliche Entscheidung.
	time.Sleep(3 * testPollInterval)
	mid, err := store.GetExecution(exec.ID)
	if err != nil {
		t.Fatalf("GetExecution() error = %v", err)
	}
	if mid.Status == StatusCompleted || mid.Status == StatusFailed {
		t.Fatalf("execution finished (%s) before the human decision was made", mid.Status)
	}

	claimed, err := engine.CompleteHumanTask(task.ID, task.RowVersion, HumanTaskStatusClaimed, "", "")
	if err != nil {
		t.Fatalf("CompleteHumanTask(claim) error = %v", err)
	}
	if _, err := engine.CompleteHumanTask(claimed.ID, claimed.RowVersion, HumanTaskStatusApproved, "approve", "sieht gut aus"); err != nil {
		t.Fatalf("CompleteHumanTask(approve) error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	ran := map[string]bool{}
	for _, s := range steps {
		ran[s.StepID] = true
	}
	if !ran["publish"] {
		t.Errorf("expected 'publish' to run after an 'approve' decision, steps=%v", ran)
	}
	if ran["rework"] {
		t.Errorf("did NOT expect 'rework' to run after an 'approve' decision, steps=%v", ran)
	}
}

// ---- Retry -----------------------------------------------

func TestEngineRetrySucceedsAfterTransientFailures(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "flaky",
		Steps: []Step{{
			ID:   "flaky",
			Type: StepTypeTask,
			Retry: &RetryPolicy{
				MaxAttempts:  5,
				Backoff:      "fixed",
				InitialDelay: "10ms",
			},
		}},
	})

	var attempts atomic.Int32
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		n := attempts.Add(1)
		if n < 3 {
			return nil, fmt.Errorf("transient failure #%d", n)
		}
		return json.RawMessage(`{"ok":true}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 3*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed after retries (error=%q)", final.Status, final.Error)
	}
	if got := attempts.Load(); got != 3 {
		t.Errorf("attempts = %d, want exactly 3 (succeeds on the 3rd)", got)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 1 {
		t.Fatalf("ListStepExecutions() = %d rows, want exactly 1 (retries must not create new rows, A3/A4)", len(steps))
	}
	if steps[0].Attempt != 3 {
		t.Errorf("step attempt = %d, want 3", steps[0].Attempt)
	}
}

func TestEngineRetryExhaustedFailsExecution(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "always-fails",
		Steps: []Step{{
			ID:   "always-fails",
			Type: StepTypeTask,
			Retry: &RetryPolicy{
				MaxAttempts:  2,
				Backoff:      "fixed",
				InitialDelay: "10ms",
			},
		}},
	})

	var attempts atomic.Int32
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		attempts.Add(1)
		return nil, errors.New("permanent failure")
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed after exhausting retries", final.Status)
	}
	if got := attempts.Load(); got != 2 {
		t.Errorf("attempts = %d, want exactly 2 (MaxAttempts)", got)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 1 || steps[0].Status != StatusFailed || steps[0].Attempt != 2 {
		t.Fatalf("ListStepExecutions() = %+v, want single failed step with attempt=2", steps)
	}
}

// ---- Timeout -----------------------------------------------

func TestEngineTimeoutMarksStepTimedOut(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "slow",
		Steps: []Step{{
			ID:             "slow",
			Type:           StepTypeTask,
			TimeoutSeconds: 1,
		}},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		select {
		case <-time.After(5 * time.Second):
			return json.RawMessage(`{}`), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 3*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (step timed out, no retry configured)", final.Status)
	}

	steps, err := store.ListStepExecutions(exec.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 1 || steps[0].Status != StatusTimedOut {
		t.Fatalf("ListStepExecutions() = %+v, want single timed_out step", steps)
	}
}

// ---- Kompensation -----------------------------------------------

func TestEngineCompensationRunsAfterFailure(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "risky",
		Steps: []Step{
			{ID: "risky", Type: StepTypeTask, CompensationStepID: "rollback"},
			{ID: "rollback", Type: StepTypeCompensation},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return nil, errors.New("boom")
	}))
	var compensated atomic.Bool
	engine.Register(StepTypeCompensation, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		compensated.Store(true)
		return json.RawMessage(`{}`), nil
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	// Bewusst NUR StatusCompensated erwarten, nicht zusätzlich
	// StatusFailed: "failed" ist hier ein gewollter, kurzlebiger
	// Zwischenzustand (finalize() schreibt erst "failed", danach sofort
	// "compensating", s. engine.go) — ein Poll, der GENAU in dieses
	// Mikrosekundenfenster fällt, hätte mit "failed" in der Warteliste
	// fälschlich vorzeitig abgebrochen (per Stresstest gefunden: ein
	// scheinbar flakiger Testfehlschlag, der in Wahrheit keiner war —
	// die Engine kompensierte tatsächlich immer korrekt, nur dieser
	// Test-Helper akzeptierte den Zwischenzustand als Endergebnis).
	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompensated)
	if final.Status != StatusCompensated {
		t.Fatalf("execution status = %s, want compensated (error=%q)", final.Status, final.Error)
	}
	if !compensated.Load() {
		t.Fatalf("compensation executor was never invoked")
	}
}

func TestEngineCompensationFailureLeavesExecutionFailed(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "risky",
		Steps: []Step{
			{ID: "risky", Type: StepTypeTask, CompensationStepID: "rollback"},
			{ID: "rollback", Type: StepTypeCompensation},
		},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return nil, errors.New("boom")
	}))
	engine.Register(StepTypeCompensation, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return nil, errors.New("rollback also failed")
	}))

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompensated, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (compensation itself failed, must not report success)", final.Status)
	}
}

// ---- Subworkflow -----------------------------------------------

func TestEngineSubworkflowWaitsForChildCompletion(t *testing.T) {
	engine, store := testEngine(t)
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{"child":"done"}`), nil
	}))

	_, childVersion := publishedVersion(t, store, Definition{
		StartStepID: "child-step",
		Steps:       []Step{{ID: "child-step", Type: StepTypeTask}},
	})

	cfg, err := json.Marshal(subworkflowConfig{ProcessDefinitionID: childVersion.ProcessDefinitionID})
	if err != nil {
		t.Fatalf("marshal subworkflow config: %v", err)
	}
	_, parentVersion := publishedVersion(t, store, Definition{
		StartStepID: "spawn",
		Steps:       []Step{{ID: "spawn", Type: StepTypeSubworkflow, Config: cfg}},
	})

	parentExec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: parentVersion.ProcessDefinitionID, ProcessVersionID: parentVersion.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, parentExec.ID, 3*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("parent execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}

	children, err := store.ListExecutions(ExecutionFilter{ParentExecutionID: parentExec.ID})
	if err != nil {
		t.Fatalf("ListExecutions(parent) error = %v", err)
	}
	if len(children) != 1 {
		t.Fatalf("ListExecutions(parent) = %d children, want 1", len(children))
	}
	if children[0].Status != StatusCompleted {
		t.Errorf("child execution status = %s, want completed", children[0].Status)
	}

	spawnStep := awaitStepExecution(t, store, parentExec.ID, "spawn", time.Second)
	// Semantischer Vergleich statt Byte-Gleichheit: Postgres JSONB
	// normalisiert Whitespace beim Roundtrip (gleicher Grund wie
	// process/store_test.go TestExecutionStatusTransitionsAndOptimisticConcurrency).
	var gotOutput map[string]any
	if err := json.Unmarshal(spawnStep.Output, &gotOutput); err != nil {
		t.Fatalf("unmarshal spawn step output: %v", err)
	}
	if gotOutput["child"] != "done" {
		t.Errorf("spawn step output = %s, want the child execution's output (child=done) to be threaded through", spawnStep.Output)
	}
}

// ---- Cancel -----------------------------------------------

func TestEngineCancelInterruptsLongRunningStep(t *testing.T) {
	engine, store := testEngine(t)
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "forever",
		Steps: []Step{{
			ID:     "forever",
			Type:   StepTypeWait,
			Config: mustMarshal(t, waitConfig{Seconds: 3600}),
		}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	awaitStepExecution(t, store, exec.ID, "forever", time.Second)

	started := time.Now()
	if _, err := engine.Cancel(exec.ID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCancelled)
	if final.Status != StatusCancelled {
		t.Fatalf("execution status = %s, want cancelled", final.Status)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("Cancel() took %s to take effect, want well under the 3600s wait duration (context cancellation should interrupt it immediately)", elapsed)
	}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

// ---- Recovery nach Neustart (B16) -----------------------------------------------

func TestEngineRecoverAllResumesAfterSimulatedRestart(t *testing.T) {
	store := NewStore(testDB(t))
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "review",
		Steps:       []Step{{ID: "review", Type: StepTypeHumanTask}},
	})

	// Erste "Prozess-Instanz": startet die Execution, kommt bis zum
	// wartenden HumanTask, wird dann hart beendet (Shutdown simuliert
	// KEINEN sauberen Stop — B16 verlangt ausdrücklich "Prozess killen",
	// kein Graceful-Shutdown; hier reicht es, die erste Engine schlicht
	// nicht mehr zu benutzen, ihr Zustand lebt ohnehin nur in Postgres).
	firstEngine := NewEngine(store, WithPollInterval(testPollInterval))
	exec, err := firstEngine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	reviewSE := awaitStepExecution(t, store, exec.ID, "review", time.Second)
	task := awaitHumanTask(t, store, reviewSE.ID, time.Second)
	firstEngine.Shutdown() // "Prozess-Ende" — keine weitere Verarbeitung durch diese Instanz

	// Simuliert den Neustart: eine VÖLLIG neue Engine auf demselben Store.
	secondEngine := NewEngine(store, WithPollInterval(testPollInterval))
	t.Cleanup(secondEngine.Shutdown)
	if err := secondEngine.RecoverAll(); err != nil {
		t.Fatalf("RecoverAll() error = %v", err)
	}

	// Die Entscheidung kommt erst NACH dem simulierten Neustart.
	claimed, err := secondEngine.CompleteHumanTask(task.ID, task.RowVersion, HumanTaskStatusClaimed, "", "")
	if err != nil {
		t.Fatalf("CompleteHumanTask(claim) error = %v", err)
	}
	if _, err := secondEngine.CompleteHumanTask(claimed.ID, claimed.RowVersion, HumanTaskStatusApproved, "approve", ""); err != nil {
		t.Fatalf("CompleteHumanTask(approve) error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status after simulated restart = %s, want completed (B16: workflow must continue correctly after a restart)", final.Status)
	}
}

// ---- Notification -----------------------------------------------

type spyPublisher struct {
	mu       sync.Mutex
	subjects []string
}

func (p *spyPublisher) Publish(subject string, payload []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.subjects = append(p.subjects, subject)
	return nil
}

func (p *spyPublisher) has(prefix string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.subjects {
		if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

// awaitPublished pollt, bis publisher ein Subject mit prefix gesehen hat.
// Nötig, weil das Publizieren (engine.go publishExecutionEvent) im
// selben Goroutine-Ablauf ERST NACH dem DB-Schreiben auf "completed"
// passiert — ein Test, der nur einmalig direkt nach
// awaitExecutionStatus(...StatusCompleted...) prüft, kann in genau das
// Zeitfenster zwischen beiden fallen (gleiche Fehlerklasse wie bei
// TestEngineCompensationRunsAfterFailure, s. docs/decisions.md
// Nachtrag 260 — ein per Stresstest gefundener, zu ungeduldiger
// Test-Check, keine Race in der Engine selbst).
func awaitPublished(t *testing.T, publisher *spyPublisher, prefix string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if publisher.has(prefix) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	publisher.mu.Lock()
	got := append([]string(nil), publisher.subjects...)
	publisher.mu.Unlock()
	t.Fatalf("no published subject with prefix %q within %s, got %v", prefix, timeout, got)
}

func TestEngineNotificationAndExecutionCompletedEventsPublish(t *testing.T) {
	publisher := &spyPublisher{}
	engine, store := testEngine(t, WithEventPublisher(publisher))

	cfg := mustMarshal(t, notificationConfig{Subject: "omp.asset.created", Payload: json.RawMessage(`{"assetId":"a1"}`)})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "notify",
		Steps:       []Step{{ID: "notify", Type: StepTypeNotification, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}

	awaitPublished(t, publisher, "omp.asset.created", time.Second)
	awaitPublished(t, publisher, "omp.process."+exec.ID+".completed", time.Second)
}

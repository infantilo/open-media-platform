package process

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---- ServiceCall -----------------------------------------------------------------------------

func TestEngineServiceCallInvokesRealHTTPServerAndCapturesResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("got method %s, want POST", r.Method)
		}
		if r.Header.Get("X-Test") != "yes" {
			t.Errorf("got X-Test header = %q, want 'yes'", r.Header.Get("X-Test"))
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)

	engine, store := testEngine(t)
	engine.Register(StepTypeServiceCall, NewServiceCallExecutor(nil))

	cfg := mustMarshal(t, serviceCallConfig{
		Method:  http.MethodPost,
		URL:     srv.URL,
		Headers: map[string]string{"X-Test": "yes"},
		Body:    json.RawMessage(`{"hello":"world"}`),
	})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "call",
		Steps:       []Step{{ID: "call", Type: StepTypeServiceCall, Config: cfg}},
	})

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
	var out serviceCallOutput
	if err := json.Unmarshal(steps[0].Output, &out); err != nil {
		t.Fatalf("unmarshal step output: %v (raw=%s)", err, steps[0].Output)
	}
	if out.Status != http.StatusOK {
		t.Errorf("output.status = %d, want 200", out.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(out.Body, &body); err != nil || body["ok"] != true {
		t.Errorf("output.body = %s, want {\"ok\":true}", out.Body)
	}
}

func TestEngineServiceCallNonSuccessStatusFailsTheStep(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":"down"}`))
	}))
	t.Cleanup(srv.Close)

	engine, store := testEngine(t)
	engine.Register(StepTypeServiceCall, NewServiceCallExecutor(nil))

	cfg := mustMarshal(t, serviceCallConfig{URL: srv.URL})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "call",
		Steps:       []Step{{ID: "call", Type: StepTypeServiceCall, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (upstream returned 503)", final.Status)
	}
}

func TestNewServiceCallExecutorRejectsMissingURL(t *testing.T) {
	ex := NewServiceCallExecutor(nil)
	ec := ExecutionCtx{Execution: ProcessExecution{}, StepExec: ProcessStepExecution{Attempt: 1}}
	_, err := ex.Execute(context.Background(), ec, Step{ID: "call", Type: StepTypeServiceCall, Config: json.RawMessage(`{}`)})
	if err == nil {
		t.Fatal("Execute() error = nil, want error (missing url)")
	}
}

// ---- MediaFunction ---------------------------------------------------------------------------

// fakeNodeResolver ist ein Test-Double für NodeResolver — kein echter,
// laufender OMP-Node steht in dieser Testumgebung zur Verfügung (s.
// Aufgabenkontext), daher hier bewusst ein Fake statt eines echten
// registry.Store (der würde ohnehin nur dieselbe Map-Suche kapseln,
// bereits separat in internal/registry/store_test.go verifiziert).
type fakeNodeResolver struct {
	baseURLs map[string]string
}

func (f *fakeNodeResolver) ResolveAPIBaseURL(instanceID string) (string, bool) {
	u, ok := f.baseURLs[instanceID]
	return u, ok
}

func TestEngineMediaFunctionInvokesResolvedNodeOverRealHTTP(t *testing.T) {
	var gotPath string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)

	resolver := &fakeNodeResolver{baseURLs: map[string]string{"inst-recorder-1": srv.URL}}
	engine, store := testEngine(t)
	engine.Register(StepTypeMediaFunction, newMediaFunctionExecutor(resolver, newHTTPMethodInvoker(nil)))

	cfg := mustMarshal(t, mediaFunctionConfig{InstanceID: "inst-recorder-1", Method: "record.start", Args: json.RawMessage(`{"target":"clip-1"}`)})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "start",
		Steps:       []Step{{ID: "start", Type: StepTypeMediaFunction, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
	if gotPath != "/methods/record.start" {
		t.Errorf("got path = %q, want /methods/record.start", gotPath)
	}
	var args map[string]any
	if err := json.Unmarshal(gotBody, &args); err != nil || args["target"] != "clip-1" {
		t.Errorf("got body = %s, want {\"target\":\"clip-1\"}", gotBody)
	}
}

func TestEngineMediaFunctionUnknownInstanceFailsHonestly(t *testing.T) {
	resolver := &fakeNodeResolver{baseURLs: map[string]string{}}
	engine, store := testEngine(t)
	engine.Register(StepTypeMediaFunction, newMediaFunctionExecutor(resolver, newHTTPMethodInvoker(nil)))

	cfg := mustMarshal(t, mediaFunctionConfig{InstanceID: "inst-offline", Method: "record.start"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "start",
		Steps:       []Step{{ID: "start", Type: StepTypeMediaFunction, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (instance not resolvable)", final.Status)
	}
}

// ---- Script -----------------------------------------------------------------------------------

func TestEngineScriptRunsAllowedCommandWithTemplatedArgs(t *testing.T) {
	eval, err := NewEvaluator()
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	engine, store := testEngine(t)
	engine.Register(StepTypeScript, NewScriptExecutor(map[string]string{"echo": "/bin/echo"}, eval))

	cfg := mustMarshal(t, scriptConfig{Command: "echo", Args: []string{"${input.asset.name}", "fixed-arg"}})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "run",
		Steps:       []Step{{ID: "run", Type: StepTypeScript, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{
		ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester",
		Input: json.RawMessage(`{"asset":{"name":"clip-42"}}`),
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
	var out scriptOutput
	if err := json.Unmarshal(steps[0].Output, &out); err != nil {
		t.Fatalf("unmarshal step output: %v (raw=%s)", err, steps[0].Output)
	}
	if out.ExitCode != 0 {
		t.Errorf("exitCode = %d, want 0", out.ExitCode)
	}
	if got := out.Stdout; got != "clip-42 fixed-arg\n" {
		t.Errorf("stdout = %q, want %q (templated arg must resolve from input)", got, "clip-42 fixed-arg\n")
	}
}

func TestEngineScriptRejectsCommandOutsideAllowList(t *testing.T) {
	eval, err := NewEvaluator()
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	engine, store := testEngine(t)
	engine.Register(StepTypeScript, NewScriptExecutor(map[string]string{"echo": "/bin/echo"}, eval))

	cfg := mustMarshal(t, scriptConfig{Command: "rm", Args: []string{"-rf", "/"}})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "run",
		Steps:       []Step{{ID: "run", Type: StepTypeScript, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed ('rm' is not in the allow-list)", final.Status)
	}
}

func TestEngineScriptNonZeroExitFailsTheStep(t *testing.T) {
	eval, err := NewEvaluator()
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	engine, store := testEngine(t)
	engine.Register(StepTypeScript, NewScriptExecutor(map[string]string{"false": "/bin/false"}, eval))

	cfg := mustMarshal(t, scriptConfig{Command: "false"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "run",
		Steps:       []Step{{ID: "run", Type: StepTypeScript, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (/bin/false exits 1)", final.Status)
	}
}

func TestEngineScriptTimeoutFailsTheStep(t *testing.T) {
	eval, err := NewEvaluator()
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	engine, store := testEngine(t)
	engine.Register(StepTypeScript, NewScriptExecutor(map[string]string{"sleep": "/bin/sleep"}, eval))

	cfg := mustMarshal(t, scriptConfig{Command: "sleep", Args: []string{"5"}, TimeoutSeconds: 1})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "run",
		Steps:       []Step{{ID: "run", Type: StepTypeScript, Config: cfg}},
	})

	exec, err := engine.Start(CreateExecutionParams{ProcessDefinitionID: v.ProcessDefinitionID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	final := awaitExecutionStatus(t, store, exec.ID, 4*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusFailed {
		t.Fatalf("execution status = %s, want failed (1s timeout on a 5s sleep)", final.Status)
	}
}

// ---- interpolate (Nachtrag 270) ---------------------------------------------------------------

func TestInterpolateEmbeddedWholeAndEdgeCases(t *testing.T) {
	eval, _ := NewEvaluator()
	vars := map[string]any{
		"input":   map[string]any{"id": "a1", "n": 3},
		"outputs": map[string]any{"probe": map[string]any{"path": "/m/x.mxf"}},
	}
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{"${outputs.probe.path}", "/m/x.mxf"},
		{"/out/${input.id}.mp4", "/out/a1.mp4"},
		{"${input.id}-${input.n + 1}", "a1-4"},
		{`${ {"k": "v}"}.k }`, "v}"}, // "}" in String und Map-Literal
		{"no vars $HOME {x}", "no vars $HOME {x}"},
	}
	for _, c := range cases {
		got, err := interpolate(eval, vars, c.in)
		if err != nil || got != c.want {
			t.Errorf("interpolate(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	if _, err := interpolate(eval, vars, "/out/${input.id.mp4"); err == nil {
		t.Error("interpolate(unterminated) error = nil, want error")
	}
}

func TestServiceCallInterpolatesURLAndHeaders(t *testing.T) {
	var gotPath, gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotHeader = r.URL.Path, r.Header.Get("X-Asset")
		w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	ex := NewServiceCallExecutor(nil)
	ec := ExecutionCtx{Execution: ProcessExecution{Input: json.RawMessage(`{"assetId":"a42"}`)}, StepExec: ProcessStepExecution{Attempt: 1}}
	cfg, _ := json.Marshal(serviceCallConfig{URL: srv.URL + "/assets/${input.assetId}", Headers: map[string]string{"X-Asset": "id=${input.assetId}"}})
	if _, err := ex.Execute(context.Background(), ec, Step{ID: "call", Type: StepTypeServiceCall, Config: cfg}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if gotPath != "/assets/a42" || gotHeader != "id=a42" {
		t.Fatalf("path/header = %q/%q, want /assets/a42 / id=a42", gotPath, gotHeader)
	}
}

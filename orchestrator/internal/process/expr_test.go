package process

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEvaluatorBasicComparison(t *testing.T) {
	e, err := NewEvaluator()
	if err != nil {
		t.Fatalf("NewEvaluator() error = %v", err)
	}
	vars := map[string]any{
		"input":    map[string]any{"asset": map[string]any{"duration": 45.0}},
		"outputs":  map[string]any{"qc": map[string]any{"score": 0.97}},
		"workflow": map[string]any{"retryCount": 0},
	}

	cases := []struct {
		expr string
		want bool
	}{
		{"input.asset.duration > 30", true},
		{"input.asset.duration > 100", false},
		{`outputs.qc.score >= 0.95`, true},
		{"workflow.retryCount < 3", true},
		{"input.asset.duration > 30 && outputs.qc.score >= 0.95", true},
		{"input.asset.duration > 30 && outputs.qc.score >= 0.999", false},
	}
	for _, c := range cases {
		got, err := e.EvalBool(c.expr, vars)
		if err != nil {
			t.Fatalf("EvalBool(%q) error = %v", c.expr, err)
		}
		if got != c.want {
			t.Errorf("EvalBool(%q) = %v, want %v", c.expr, got, c.want)
		}
	}
}

func TestEvaluatorRejectsNonBooleanResult(t *testing.T) {
	e, _ := NewEvaluator()
	if _, err := e.EvalBool("input.asset.duration", map[string]any{
		"input": map[string]any{"asset": map[string]any{"duration": 45.0}},
	}); err == nil {
		t.Fatalf("EvalBool() with a non-boolean expression error = nil, want error")
	}
}

func TestEvaluatorRejectsSyntaxError(t *testing.T) {
	e, _ := NewEvaluator()
	if _, err := e.EvalBool("input.asset.duration >>> 30", map[string]any{}); err == nil {
		t.Fatalf("EvalBool() with invalid syntax error = nil, want error")
	}
}

func TestEvaluatorMissingFieldIsAnErrorNotAPanic(t *testing.T) {
	e, _ := NewEvaluator()
	// input ist hier nil (kein "asset"-Feld) — muss als Fehler
	// zurückkommen, nicht die Engine zum Absturz bringen (A5: robust
	// gegen fehlerhafte/unerwartete Nutzereingaben in Step.Config).
	_, err := e.EvalBool("input.asset.duration > 30", map[string]any{
		"input": nil, "outputs": map[string]any{}, "workflow": map[string]any{},
	})
	if err == nil {
		t.Fatalf("EvalBool() with missing nested field error = nil, want error")
	}
}

// TestEvaluatorHasNoHostAccess ist der in expr.go versprochene
// Sicherheitsnachweis für A5 ("Expressions dürfen keinen unkontrollierten
// Zugriff auf das Host-System erlauben") — per TEST belegt, nicht nur
// behauptet: ein Ausdruck, der versucht, eine Funktion aufzurufen (egal
// welchen Namen), muss beim Kompilieren scheitern, weil keine einzige
// Funktion registriert ist (expr.Env(vars) deklariert nur Datenvariablen,
// keine expr.Function-Aufrufe).
func TestEvaluatorHasNoHostAccess(t *testing.T) {
	e, _ := NewEvaluator()
	vars := map[string]any{"input": map[string]any{}, "outputs": map[string]any{}, "workflow": map[string]any{}}

	attempts := []string{
		`exec("id")`,
		`os.ReadFile("/etc/passwd")`,
		`readFile("/etc/passwd")`,
		`import("os")`,
		`httpGet("http://example.com")`,
		`system("id")`,
	}
	for _, expression := range attempts {
		if _, err := e.EvalBool(expression, vars); err == nil {
			t.Errorf("EvalBool(%q) error = nil, want a compile error (no such function should ever be registered)", expression)
		} else if !strings.Contains(err.Error(), "compile") && !strings.Contains(err.Error(), "unknown") {
			// Nicht streng auf den exakten Fehlertext geprüft (expr-lang
			// formuliert Fehlermeldungen frei) — nur, dass es überhaupt
			// einen Fehler gibt, ist die eigentliche Sicherheitsaussage.
			t.Logf("EvalBool(%q) failed as expected with: %v", expression, err)
		}
	}
}

func TestExprVarsBuildsFromExecutionCtx(t *testing.T) {
	ec := ExecutionCtx{
		Execution: ProcessExecution{
			ID:            "exec-1",
			CorrelationID: "corr-1",
			Input:         json.RawMessage(`{"asset":{"duration":50}}`),
		},
		StepExec: ProcessStepExecution{Attempt: 2},
		Outputs: map[string]json.RawMessage{
			"qc": json.RawMessage(`{"score":0.99}`),
		},
	}
	vars := exprVars(ec)

	e, _ := NewEvaluator()
	ok, err := e.EvalBool("input.asset.duration > 30 && outputs.qc.score >= 0.95 && workflow.retryCount == 1", vars)
	if err != nil {
		t.Fatalf("EvalBool() error = %v", err)
	}
	if !ok {
		t.Errorf("EvalBool() = false, want true (attempt=2 -> retryCount=1)")
	}
}

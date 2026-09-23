package process

import "testing"

// Die vom grafischen Editor erzeugten Ausdrucksformen (ui/graph/
// process-step-config-logic.ts: ruleToExpression/variableOptions) müssen
// von expr-lang tatsächlich akzeptiert werden — Nachtrag 270.
func TestEditorGeneratedExpressionForms(t *testing.T) {
	eval, _ := NewEvaluator()
	vars := map[string]any{
		"input":   map[string]any{"title": "News 20 Uhr", "n": 3},
		"outputs": map[string]any{"a-b": map[string]any{"exitCode": 0}, "review": map[string]any{"decision": "approved"}},
	}
	for expr, want := range map[string]bool{
		`outputs.review.decision == "approved"`: true,
		`outputs["a-b"].exitCode >= 1`:          false,
		`input.title contains "News"`:           true,
		`input.title startsWith "Wetter"`:       false,
		`input.n != 3`:                          false,
	} {
		got, err := eval.EvalBool(expr, vars)
		if err != nil || got != want {
			t.Errorf("EvalBool(%s) = %v, %v; want %v", expr, got, err, want)
		}
	}
}

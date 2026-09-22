package process

import (
	"encoding/json"
	"fmt"

	"github.com/expr-lang/expr"
)

// Evaluator kompiliert und wertet sichere, sandboxte Ausdrücke aus (A5:
// "Verwende nach Möglichkeit eine etablierte sichere Expression Language
// statt eine eigene unsichere Script-Sprache zu entwickeln"). Nutzt
// expr-lang/expr — Ausnahme von der Minimal-Dependency-Regel
// (UMSETZUNG.md §0 Punkt 5), hier ausdrücklich begründet:
//
//   - Eine sichere Ausdruckssprache SELBST zu bauen (Parser, Sandboxing,
//     Typprüfung) wäre exakt das Gegenteil von "sicher" — die
//     Aufgabenstellung verlangt ausdrücklich eine etablierte Bibliothek.
//   - Erste Wahl wäre `cel-go` (Googles Common Expression Language, u. a.
//     in Kubernetes/Envoy im Einsatz) gewesen — bei der Einbindung zeigte
//     sich jedoch, dass es wegen seiner optionalen Protobuf-Typ-
//     Integration einen erheblichen Abhängigkeitsbaum mitzieht
//     (google.golang.org/protobuf, google.golang.org/genproto, ein
//     ANTLR-Parsergenerator, ein YAML-Paket), obwohl hier nur einfache
//     Ausdrücke gegen dynamische JSON-Daten ausgewertet werden — passt
//     nicht zur wiederholt betonten Minimal-Dependency-Linie des Projekts
//     (ARCHITECTURE.md §4.1a). `expr-lang/expr` (weit verbreitet, u. a.
//     von mehreren CNCF-nahen Projekten für genau diesen Zweck genutzt)
//     hat dagegen KEINE einzige externe Abhängigkeit (reiner Go-Stdlib-
//     Code, s. `go.sum`-Diff dieser Änderung — zwei Zeilen) und bietet
//     dieselbe Sicherheitseigenschaft.
//   - Sicherheitseigenschaft, die A5 verlangt ("Expressions dürfen
//     keinen unkontrollierten Zugriff auf das Host-System erlauben"):
//     expr wertet nur gegen die explizit übergebene `vars`-Map aus —
//     ohne per `expr.Function`/`expr.Env` mit einem Struct registrierte
//     Methoden (hier bewusst NICHT genutzt) gibt es keinen Weg zu
//     Host-Funktionen, Dateisystem oder Netzwerk. S. expr_test.go für
//     einen Nachweis per Test, nicht nur Behauptung.
//
// Drei feste Top-Level-Variablen (identische Begründung wie ein
// CEL-Ansatz gehabt hätte — expr kann ebenfalls keine zur Laufzeit aus
// den Daten "erratenen" Bezeichner deklarieren):
//
//	input     — ExecutionCtx.Execution.Input (das Start-Input der Execution)
//	outputs   — map[stepID]Output aller bisher abgeschlossenen Schritte
//	workflow  — eingebaute Metadaten (retryCount/executionId/correlationId)
//
// Die Beispiele der Aufgabenstellung ("asset.duration > 30",
// "qc.score >= 0.95") sind Illustrationen der DATENFORM, nicht eine
// wörtliche Grammatikvorgabe — mit den drei festen Containern werden sie
// zu "input.asset.duration > 30" bzw. "outputs.qc.score >= 0.95"
// (angenommen, das Input enthält ein "asset"-Feld bzw. ein Schritt namens
// "qc" lieferte {"score": ...}) — dieselbe Ausdruckskraft, aber mit einer
// von Anfang an bekannten, sicheren Variablenmenge statt beliebiger zur
// Laufzeit erfundener Bezeichner.
type Evaluator struct{}

// NewEvaluator existiert (statt einer reinen Funktion) für Symmetrie mit
// dem Rest des Pakets (Store/Engine sind ebenfalls Werte mit New…-
// Konstruktor) und als Erweiterungspunkt, falls eine künftige Version
// einen Programm-Cache braucht.
func NewEvaluator() (*Evaluator, error) {
	return &Evaluator{}, nil
}

// EvalBool kompiliert expression und wertet sie gegen vars aus — erwartet
// ein Boolean-Ergebnis (Condition/Branch-Entscheidungen, A5). Jeder
// Aufruf kompiliert neu (kein Programm-Cache in dieser Runde — Schritte
// werden nicht mit hoher Frequenz wiederholt ausgewertet, ein Cache wäre
// verfrühte Optimierung ohne belegten Bedarf).
func (e *Evaluator) EvalBool(expression string, vars map[string]any) (bool, error) {
	program, err := expr.Compile(expression, expr.AsBool(), expr.Env(vars))
	if err != nil {
		return false, fmt.Errorf("process: compile expression %q: %w", expression, err)
	}
	out, err := expr.Run(program, vars)
	if err != nil {
		return false, fmt.Errorf("process: evaluate expression %q: %w", expression, err)
	}
	b, ok := out.(bool)
	if !ok {
		return false, fmt.Errorf("process: expression %q did not evaluate to a boolean (got %T)", expression, out)
	}
	return b, nil
}

// exprVars baut die drei deklarierten Top-Level-Variablen (s. Evaluator-
// Doku) aus dem Ausführungskontext eines Schritts.
func exprVars(ec ExecutionCtx) map[string]any {
	var input any
	if len(ec.Execution.Input) > 0 {
		_ = json.Unmarshal(ec.Execution.Input, &input)
	}

	outputs := make(map[string]any, len(ec.Outputs))
	for stepID, raw := range ec.Outputs {
		var v any
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &v); err == nil {
				outputs[stepID] = v
			}
		}
	}

	workflow := map[string]any{
		"executionId":   ec.Execution.ID,
		"correlationId": ec.Execution.CorrelationID,
		// retryCount: Attempt ist 1-basiert (erster Versuch = 1, s.
		// ProcessStepExecution-Doku) — retryCount ist die Anzahl bereits
		// verbrauchter WIEDERHOLUNGEN, also Attempt-1, damit
		// "workflow.retryCount < 3" beim allerersten Versuch (Attempt=1)
		// wie erwartet 0 < 3 liefert, nicht 1 < 3 (was den Sonderfall
		// "noch nie wiederholt" verdeckt hätte).
		"retryCount": ec.StepExec.Attempt - 1,
	}

	return map[string]any{
		"input":    input,
		"outputs":  outputs,
		"workflow": workflow,
	}
}

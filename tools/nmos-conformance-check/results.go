// Package main: nmos-conformance-check wertet die JSON-Ergebnisdatei des
// AMWA NMOS Testing Tool aus (UMSETZUNG.md D2) und liefert einen klaren
// CI-Gate: alle Tests mit state=="Fail" müssen entweder tatsächlich grün
// sein oder explizit über --allow als bekannte, begründete Abweichung
// vermerkt sein ("definierte Testliste grün, Abweichungen dokumentiert",
// UMSETZUNG.md D2-Verifikationskriterium). Kein eigenes Python-Tooling
// dafür (die Minimal-Dependency-Regel gilt auch sprachübergreifend) —
// dieselbe Go-für-Tooling-Linie wie tools/contract-check (C9).
package main

import (
	"encoding/json"
	"fmt"
)

// TestResult ist die für dieses Tool relevante Teilmenge eines Eintrags
// in der `results`-Liste der AMWA-JSON-Ausgabe (`nmos-test.py suite …
// --output …json`). Weitere Felder (z.B. "range") werden ignoriert.
type TestResult struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Detail string `json:"detail"`
}

// ResultsFile ist die Top-Level-Struktur der AMWA-JSON-Ausgabe — nur die
// hier gebrauchten Felder abgebildet.
type ResultsFile struct {
	Suite   string       `json:"suite"`
	Results []TestResult `json:"results"`
}

// AllowedFailure ist eine per --allow deklarierte, begründete Abweichung
// von "alles muss grün sein".
type AllowedFailure struct {
	TestName string
	Reason   string
}

// Outcome fasst eine Auswertung zusammen — Rückgabewert von Evaluate(),
// damit main() nur noch formatieren/exiten muss (Evaluate() selbst ist
// so unit-testbar, results_test.go).
type Outcome struct {
	Suite              string
	PassCount          int
	OtherCount         int // Not Applicable/Test Disabled/Manual/Could Not Test/Not Implemented — keine echten Fails, aber auch kein Pass
	IgnoredFailures    []AllowedFailure // tatsächlich als "Fail" gemeldet, aber per --allow erwartet
	UnexpectedFailures []TestResult     // "Fail", aber nicht in der Allow-Liste — das ist der Gate-Fehler
}

// Passed ist true, wenn keine unerwarteten Fails aufgetreten sind — die
// einzige vom Aufrufer (main) geprüfte Bedingung für den Exit-Code.
func (o Outcome) Passed() bool {
	return len(o.UnexpectedFailures) == 0
}

// Evaluate wertet eine geparste Ergebnisdatei gegen die Allow-Liste aus.
// allow ist ein Set erlaubter Testnamen -> Begründung (Testname muss
// exakt dem `name`-Feld der AMWA-Ausgabe entsprechen, z.B. "test_27").
func Evaluate(rf ResultsFile, allow map[string]string) Outcome {
	out := Outcome{Suite: rf.Suite}
	for _, r := range rf.Results {
		switch r.State {
		case "Pass":
			out.PassCount++
		case "Fail":
			if reason, ok := allow[r.Name]; ok {
				out.IgnoredFailures = append(out.IgnoredFailures, AllowedFailure{TestName: r.Name, Reason: reason})
			} else {
				out.UnexpectedFailures = append(out.UnexpectedFailures, r)
			}
		default:
			// "Not Applicable"/"Test Disabled"/"Manual"/"Could Not Test"/
			// "Not Implemented" — keine der beiden harten Kategorien,
			// zählt für den Gate nicht als Fail (UMSETZUNG.md D2: nur
			// echte Fails jenseits der Allow-Liste blockieren CI).
			out.OtherCount++
		}
	}
	return out
}

// ParseResultsFile liest/parsed die AMWA-JSON-Ausgabe.
func ParseResultsFile(data []byte) (ResultsFile, error) {
	var rf ResultsFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return ResultsFile{}, fmt.Errorf("parse results file: %w", err)
	}
	return rf, nil
}

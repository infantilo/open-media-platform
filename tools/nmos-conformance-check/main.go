package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// allowFlags sammelt mehrfach angegebene --allow "name=Begründung"-Flags.
type allowFlags map[string]string

func (a allowFlags) String() string { return "" }

func (a allowFlags) Set(value string) error {
	name, reason, ok := strings.Cut(value, "=")
	if !ok || name == "" || reason == "" {
		return fmt.Errorf("erwarte Form 'testname=Begründung', bekam %q", value)
	}
	a[name] = reason
	return nil
}

func main() {
	resultsPath := flag.String("results", "", "Pfad zur AMWA-JSON-Ergebnisdatei (nmos-test.py suite … --output …json)")
	allow := allowFlags{}
	flag.Var(allow, "allow", "bekannte, begründete Abweichung als 'testname=Begründung' (mehrfach angebbar)")
	flag.Parse()

	if *resultsPath == "" {
		fmt.Fprintln(os.Stderr, "nmos-conformance-check: --results erforderlich")
		os.Exit(2)
	}

	data, err := os.ReadFile(*resultsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nmos-conformance-check: %v\n", err)
		os.Exit(2)
	}

	rf, err := ParseResultsFile(data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nmos-conformance-check: %v\n", err)
		os.Exit(2)
	}

	outcome := Evaluate(rf, allow)

	fmt.Printf("Suite %s: %d pass, %d ignoriert (dokumentierte Abweichung), %d sonstige, %d unerwartet fehlgeschlagen\n",
		outcome.Suite, outcome.PassCount, len(outcome.IgnoredFailures), outcome.OtherCount, len(outcome.UnexpectedFailures))

	for _, f := range outcome.IgnoredFailures {
		fmt.Printf("  ignoriert: %s — %s\n", f.TestName, f.Reason)
	}
	for _, f := range outcome.UnexpectedFailures {
		fmt.Printf("  FEHLGESCHLAGEN: %s — %s\n", f.Name, f.Detail)
	}

	if !outcome.Passed() {
		os.Exit(1)
	}
}

// contract-check prüft den Node-Contract (ARCHITECTURE.md §5) gegen
// einen laufenden Node — Grundstein für maschinell prüfbare
// Community-Nodes (UMSETZUNG.md C9). Kein Node-Typ-Sonderwissen: nur
// Standard-IS-04/IS-05-REST und das generische Descriptor-Self-Describe
// (A8) werden angefragt.
package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// defaultSchemaPath findet docs/descriptor-v0.schema.json relativ zu
// dieser Datei, unabhängig vom Arbeitsverzeichnis, aus dem `go run`
// gestartet wird (gleiches Verfahren wie
// nodes/mock/internal/descriptor/schema_test.go).
func defaultSchemaPath() string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "docs/descriptor-v0.schema.json"
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "docs", "descriptor-v0.schema.json")
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func main() {
	nodeURL := os.Getenv("NODE_URL")
	if nodeURL == "" {
		fmt.Fprintln(os.Stderr, "contract-check: NODE_URL ist erforderlich, z. B.:")
		fmt.Fprintln(os.Stderr, "  make contract NODE_URL=http://localhost:9320")
		os.Exit(2)
	}
	registryURL := getEnv("OMP_REGISTRY_URL", "http://localhost:8010")

	compiler := jsonschema.NewCompiler()
	schema, err := compiler.Compile(defaultSchemaPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "contract-check: Schema docs/descriptor-v0.schema.json nicht kompilierbar: %v\n", err)
		os.Exit(2)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	results := Run(client, nodeURL, registryURL, schema)

	failed := false
	for _, r := range results {
		fmt.Printf("[%s] %-22s %s\n", r.Status, r.Name, r.Detail)
		if r.Status == StatusFail {
			failed = true
		}
	}

	if failed {
		fmt.Println("\ncontract-check: FAIL")
		os.Exit(1)
	}
	fmt.Println("\ncontract-check: PASS")
}

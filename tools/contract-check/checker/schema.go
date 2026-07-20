package checker

import (
	"path/filepath"
	"runtime"
)

// DefaultSchemaPath findet docs/descriptor-v0.schema.json relativ zu
// dieser Datei, unabhängig vom Arbeitsverzeichnis des Aufrufers (egal ob
// `go run ./tools/contract-check` oder — seit §17 Teil 4 — der
// Orchestrator selbst, der dieses Paket als Bibliothek für die
// C9-Konformitätsprüfung beim Katalog-Import einbindet) — gleiches
// Verfahren wie nodes/mock/internal/descriptor/schema_test.go.
func DefaultSchemaPath() string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "docs/descriptor-v0.schema.json"
	}
	// tools/contract-check/checker/schema.go -> Repo-Wurzel: drei Ebenen
	// hoch (anders als vor der §17-Teil-4-Aufteilung in ein eigenes
	// checker-Unterpaket, damals reichten zwei).
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "docs", "descriptor-v0.schema.json")
}

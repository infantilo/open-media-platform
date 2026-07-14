// Package catalog lädt den lokalen Node-Katalog eines Host-Agent
// (ARCHITECTURE.md §18.5, UMSETZUNG.md D6 Teil 2): welche Node-Typen
// dieser Host starten kann.
//
// Bewusst ein eigener, agent-lokaler Katalog statt vom Orchestrator
// übermittelter Kommandos: der Orchestrator kennt nur *seinen eigenen*
// Dateisystem-Pfad zu den Node-Binaries (`deploy/catalog.json`,
// relativ zu `deploy/`), der auf einem entfernten Host keine Bedeutung
// hat. Der Host-Agent entscheidet deshalb selbst, welche Binaries er
// unter welchem Typnamen anbietet — das ist zugleich die
// Sicherheitsgrenze für den Kommandokanal (§18.3 Punkt 4, "nur
// Katalog-Einträge, keine freien Kommandos"): ein eingehendes
// Start-Kommando kann nur einen bereits im lokalen Katalog
// freigegebenen Typ auslösen, nie einen beliebigen Befehl, auch ohne
// zusätzliche Signatur auf dem NATS-Kommandokanal selbst (s.
// docs/decisions.md D6 Teil 2 zur bewussten Abgrenzung von
// Nachrichtenauthentifizierung).
//
// Gleiches JSON-Schema wie `orchestrator/internal/launcher/catalog.go`
// (`deploy/catalog.json`) — bewusste kleine Duplikation statt eines
// dritten, von zwei Modulen importierten Pakets (gleiches Muster wie
// die mTLS-Pakete in D3 Teil 1: orchestrator und nodes/mock duplizieren
// dort ebenfalls statt ein drittes Modul einzuführen).
package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RunnerProcess ist der einzige aktuell unterstützte Runner (lokaler
// Subprozess, os/exec) — s. orchestrator/internal/launcher/catalog.go.
const RunnerProcess = "process"

// Entry ist ein auf diesem Host startbarer Node-Typ.
type Entry struct {
	Type    string            `json:"type"`
	Label   string            `json:"label"`
	Runner  string            `json:"runner"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env"`
}

// Load liest und validiert die Katalog-Datei unter path — leerer/
// fehlender Pfad ist kein Fehler (leerer Katalog, Agent registriert
// sich trotzdem, kann nur (noch) keine Kommandos ausführen).
func Load(path string) ([]Entry, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("catalog: read %s: %w", path, err)
	}

	var entries []Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("catalog: parse %s: %w", path, err)
	}

	catalogDir := filepath.Dir(path)
	for i := range entries {
		if entries[i].Runner == "" {
			entries[i].Runner = RunnerProcess
		}
		if entries[i].Type == "" {
			return nil, fmt.Errorf("catalog: entry %d has no type", i)
		}
		if len(entries[i].Command) == 0 {
			return nil, fmt.Errorf("catalog: entry %q has an empty command", entries[i].Type)
		}
		cmdPath := entries[i].Command[0]
		if strings.ContainsRune(cmdPath, '/') && !filepath.IsAbs(cmdPath) {
			entries[i].Command[0] = filepath.Join(catalogDir, cmdPath)
		}
	}

	return entries, nil
}

// Find liefert den Eintrag für nodeType (ok=false, wenn nicht im
// Katalog).
func Find(entries []Entry, nodeType string) (Entry, bool) {
	for _, e := range entries {
		if e.Type == nodeType {
			return e, true
		}
	}
	return Entry{}, false
}

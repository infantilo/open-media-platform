package launcher

import (
	"encoding/json"
	"fmt"
	"os"
)

// runnerProcess ist der einzige aktuell unterstützte Runner: der
// Orchestrator startet den Katalog-Eintrag als lokalen Subprozess
// (os/exec). ARCHITECTURE.md §6.2 hält das Feld bewusst offen für
// spätere Runner ("podman"/Quadlet), ohne sie hier zu bauen.
const runnerProcess = "process"

// CatalogEntry ist ein startbarer Node-Typ aus deploy/catalog.json
// (UMSETZUNG.md C8). Command zeigt auf ein vorgebautes Binary
// (`make nodes`) — der Launcher startet ausschließlich Katalog-
// Einträge, keine freien Kommandos (Sicherheitsgrenze, ARCHITECTURE.md
// §6.2).
type CatalogEntry struct {
	Type    string            `json:"type"`
	Label   string            `json:"label"`
	Runner  string            `json:"runner"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env"`
}

// LoadCatalog liest und validiert die Katalog-Datei unter path. Ein
// fehlender/leerer "runner" wird als "process" behandelt (Default aus
// ARCHITECTURE.md §6.2).
func LoadCatalog(path string) ([]CatalogEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("launcher: read catalog %s: %w", path, err)
	}

	var entries []CatalogEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("launcher: parse catalog %s: %w", path, err)
	}

	for i := range entries {
		if entries[i].Runner == "" {
			entries[i].Runner = runnerProcess
		}
		if entries[i].Type == "" {
			return nil, fmt.Errorf("launcher: catalog entry %d has no type", i)
		}
		if len(entries[i].Command) == 0 {
			return nil, fmt.Errorf("launcher: catalog entry %q has an empty command", entries[i].Type)
		}
	}

	return entries, nil
}

package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
//
// Relative Pfad-Kommandos (z. B. "../nodes/target/debug/omp-source") sind
// in `deploy/catalog.json` bewusst relativ zum Katalog-**Verzeichnis**
// geschrieben (`deploy/`), nicht relativ zum cwd des Orchestrator-
// Prozesses — der Prozess hat mit den absoluten `OMP_UI_DIR`/
// `OMP_DATA_DIR`-Pfaden aus `deploy/dev/start-omp.sh` gar keine
// verlässliche Cwd-Konvention mehr (Kommentar dort: "so kann der Prozess
// ohne umschließende cd-Subshell gestartet werden"). Ohne diese Auflösung
// bricht `POST /api/v1/instances` (C8) je nach Startverzeichnis mit
// "no such file or directory" — hier gefunden und behoben beim
// C10-Verifikationslauf (`UMSETZUNG.md`), kein C10-spezifisches Verhalten.
// Bare-Kommandos ohne Pfadtrenner (z. B. "true", zukünftig "podman") sind
// PATH-Lookups und bleiben unverändert.
func LoadCatalog(path string) ([]CatalogEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("launcher: read catalog %s: %w", path, err)
	}

	var entries []CatalogEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("launcher: parse catalog %s: %w", path, err)
	}

	catalogDir := filepath.Dir(path)
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
		cmdPath := entries[i].Command[0]
		if strings.ContainsRune(cmdPath, '/') && !filepath.IsAbs(cmdPath) {
			entries[i].Command[0] = filepath.Join(catalogDir, cmdPath)
		}
	}

	return entries, nil
}

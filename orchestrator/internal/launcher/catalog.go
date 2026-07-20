package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// runnerProcess startet den Katalog-Eintrag als lokalen Subprozess
// (os/exec) — das einzige bis Kapitel 17 Teil 4 unterstützte Verfahren.
// runnerPodman (docs/END-GOAL-FEATURES.md §17.3d/§17.4 Teil 4,
// Nutzerentscheidung 2026-07-20: Podman-Container statt eines weiteren
// lokal gebauten Binärpfads — "importieren" heißt damit ein echtes
// Container-Image, nicht dieselbe Build-Toolchain wie dieses Projekt)
// startet stattdessen ein Container-Image. Diese Runge liefert nur den
// Runner-Unterbau (Start/Stop/Supervise eines Containers, s. podman.go)
// — die Katalog-Schreib-API (Import über `POST /api/v1/catalog`) und
// die C9-Konformitätsprüfung als Aufnahme-Voraussetzung sind bewusst
// zurückgestellte Folgeschritte (§17.4 selbst: "größter Teil, eigene
// Sitzung(en)"), bis dahin werden `runner:"podman"`-Einträge nur über
// die statische Katalog-Datei erreicht (Live-Verifikation dieser
// Runge: ein Test-Eintrag in einer separaten Scratch-Katalog-Datei,
// nicht in `deploy/catalog.json`).
const (
	runnerProcess = "process"
	runnerPodman  = "podman"
)

// CatalogEntry ist ein startbarer Node-Typ aus deploy/catalog.json
// (UMSETZUNG.md C8). Command zeigt auf ein vorgebautes Binary
// (`make nodes`) — der Launcher startet ausschließlich Katalog-
// Einträge, keine freien Kommandos (Sicherheitsgrenze, ARCHITECTURE.md
// §6.2). Image ist das Container-Image-Pendant für `runner:"podman"`
// (Kapitel 17 Teil 4) — genau eines von Command/Image ist je nach
// Runner Pflicht, s. LoadCatalog-Validierung.
type CatalogEntry struct {
	Type    string            `json:"type"`
	Label   string            `json:"label"`
	Runner  string            `json:"runner"`
	Command []string          `json:"command"`
	Image   string            `json:"image,omitempty"`
	Env     map[string]string `json:"env"`
	// Description ist ein kurzer, für den Katalog-Nutzer verständlicher
	// Fließtext, was dieser Node-Typ tut (docs/END-GOAL-FEATURES.md §17
	// Teil 1: "es fehlen noch Beschreibungen"). Optional — ein Eintrag
	// ohne Description bleibt gültig (Community-/Fremd-Microservices, die
	// das Feld nicht setzen, sollen den Katalog nicht kaputt machen).
	Description string `json:"description,omitempty"`
	// ExpectedResources ist ein grober, von Hand gepflegter Freitext-
	// Vorab-Schätzwert ("~5% CPU · ~40 MB RAM"), keine Messung — bis
	// Kapitel 14 (Host-/Microservice-Ressourcen-Historie, noch nicht
	// gebaut) echte Min/Ø/Max-Profile aus Laufzeitmessungen liefert, ist
	// das die einzige verfügbare Ressourcen-Auskunft vor dem ersten
	// Start eines Typs. Bewusst Freitext statt eines strukturierten
	// Schemas: sobald Kapitel 14 landet, ersetzt die dort ohnehin echte
	// Messwerte, keine handgepflegten Schätzungen — ein vorgezogenes
	// striktes Schema wäre Wegwerf-Aufwand.
	ExpectedResources string `json:"expectedResources,omitempty"`
	// Version identifiziert diese Variante eines importierten Typs
	// (§17 Teil 5, docs/END-GOAL-FEATURES.md §17.4) — leer für alle
	// statischen `deploy/catalog.json`-Einträge (das Projekt versioniert
	// seine eigenen Nodes nicht über dieses Feld) und für einfache,
	// einzeln importierte Typen ohne explizite Version (unverändertes
	// Verhalten seit §17 Teil 4: leer heißt "die eine Version"). Mehrere
	// importierte Einträge desselben Type mit unterschiedlicher Version
	// dürfen parallel im Katalog stehen — Identität ist das Paar
	// (Type, Version), s. Launcher.ImportCatalogEntry/findEntry.
	Version string `json:"version,omitempty"`
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
		switch entries[i].Runner {
		case runnerPodman:
			if entries[i].Image == "" {
				return nil, fmt.Errorf("launcher: catalog entry %q (runner podman) has no image", entries[i].Type)
			}
		default:
			if len(entries[i].Command) == 0 {
				return nil, fmt.Errorf("launcher: catalog entry %q has an empty command", entries[i].Type)
			}
			cmdPath := entries[i].Command[0]
			if strings.ContainsRune(cmdPath, '/') && !filepath.IsAbs(cmdPath) {
				entries[i].Command[0] = filepath.Join(catalogDir, cmdPath)
			}
		}
	}

	return entries, nil
}

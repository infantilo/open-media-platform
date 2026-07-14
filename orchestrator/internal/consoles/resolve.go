package consoles

import (
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// StubWorkflowID/-Label: das Projekt kennt noch kein eigenständiges
// "Workflow"-Objekt (ARCHITECTURE.md §6.2, geplant erst ab D7) — es gibt
// aktuell genau einen impliziten Workflow (den einen Graphen/Canvas).
// Sobald §6.2 echte Workflows einführt, wird hier die tatsächliche
// Workflow-ID/-Label pro Node aufgelöst statt einer Konstanten.
const (
	StubWorkflowID    = "default"
	StubWorkflowLabel = "Regieplatz"
)

// NodeInfo ist die für die Auflösung nötige Teilmenge von
// registry.NodeView — als eigenes, schmales Interface gehalten, damit
// dieses Package nicht von registry abhängen muss (Tests bauen NodeInfo
// direkt, kein Registry-Store nötig).
type NodeInfo struct {
	ID         string
	Label      string
	InstanceID string
}

// ConsoleEntry ist ein Eintrag der von GET /api/v1/me/consoles
// gelieferten Liste (ARCHITECTURE.md §14). `UIBundleURL` ist bewusst die
// Basis-Route des Node-Proxys (`/api/v1/nodes/<aktuelle-node-id>`, ohne
// `/ui/manifest.json`-Suffix) statt der fertigen Manifest-URL — die Shell
// hängt `/ui/manifest.json`/`/ui/bundle.js` selbst an (dieselbe Logik wie
// beim bestehenden Engineering-Panel, `ui/shell/ui-bundle.ts`), damit
// `NodeRoleID` (stabil über Neustarts) und die aktuelle, pro Prozessstart
// wechselnde Node-ID nicht miteinander verwechselt werden.
type ConsoleEntry struct {
	WorkflowID    string `json:"workflowId"`
	WorkflowLabel string `json:"workflowLabel"`
	NodeRoleID    string `json:"nodeRoleId"`
	NodeLabel     string `json:"nodeLabel"`
	UIBundleURL   string `json:"uiBundleUrl"`
}

// Result ist der Rückgabewert von Resolve — neben der Konsolen-Liste
// selbst (ARCHITECTURE.md §14 Wortlaut) auch das Signal, ob der Nutzer
// zusätzlich configure/admin irgendwo hat (§14: "entscheidet die Shell
// für Engineering statt Console als Startansicht") — eine kleine,
// pragmatische Erweiterung der in ARCHITECTURE.md beschriebenen reinen
// Array-Antwort, weil die Shell dieses Signal sonst nicht bekäme.
type Result struct {
	HasEngineeringAccess bool           `json:"hasEngineeringAccess"`
	Consoles             []ConsoleEntry `json:"consoles"`
}

// BindingLoader liefert alle Rollenbindungen (implementiert von
// *authz.Store, UMSETZUNG.md D3 Teil 2 — ersetzt die bisherige,
// dateibasierte Bindungsquelle des C13-Stubs). Als schmales Interface
// gehalten, damit Tests ohne echte Postgres-Verbindung auskommen.
type BindingLoader interface {
	Load() ([]authz.Binding, error)
}

// Resolver löst Rollenbindungen für den authentifizierten Nutzer
// (username, s. internal/auth) gegen die aktuell bekannten Nodes auf.
type Resolver struct {
	store BindingLoader
}

// NewResolver erstellt einen Resolver, der Bindungen aus store liest.
func NewResolver(store BindingLoader) *Resolver {
	return &Resolver{store: store}
}

// NodeRoleID ist die stabile "Rolle" eines Nodes: die vom Instanz-
// Launcher vergebene Instanz-ID (UMSETZUNG.md C8, überlebt Node-
// Neustarts — anders als die pro Prozessstart neu erzeugte IS-04-
// Node-ID), ersatzweise die rohe Node-ID für manuell (nicht über den
// Launcher) gestartete Nodes. Exportiert, weil internal/httpapi
// (UMSETZUNG.md D3 Teil 2) dieselbe Rollen-ID braucht, um Rollenbindungen
// gegen einen konkreten Node-Proxy-Aufruf zu prüfen — genau dieselbe
// "Rolle" wie die, die Resolve unten für die Konsolen-Liste auflöst,
// keine zweite Definition.
func NodeRoleID(n NodeInfo) string {
	if n.InstanceID != "" {
		return n.InstanceID
	}
	return n.ID
}

// Resolve wertet alle Bindungen für username (aus dem verifizierten
// Bearer-Token, internal/auth) gegen nodes aus.
func (r *Resolver) Resolve(username string, nodes []NodeInfo) (Result, error) {
	bindings, err := r.store.Load()
	if err != nil {
		return Result{}, err
	}

	seen := make(map[string]bool, len(nodes))
	// `Consoles` explizit als leerer (nicht nil) Slice initialisiert:
	// `encoding/json` serialisiert einen nil-Slice als `null`, nicht `[]`
	// — ein per Browser-Test gefundener Bug in `ui/shell/shell.ts` zeigte,
	// dass Client-Code das nicht verlässlich selbst abfängt.
	result := Result{Consoles: []ConsoleEntry{}}
	for _, b := range bindings {
		if b.Subject != username {
			continue
		}
		if b.Verb == authz.VerbConfigure || b.Verb == authz.VerbAdmin {
			result.HasEngineeringAccess = true
		}
		if b.Verb != authz.VerbOperate {
			continue
		}
		for _, n := range nodes {
			roleID := NodeRoleID(n)
			if b.NodeID != authz.AnyNode && b.NodeID != roleID {
				continue
			}
			if seen[roleID] {
				continue
			}
			seen[roleID] = true
			result.Consoles = append(result.Consoles, ConsoleEntry{
				WorkflowID:    StubWorkflowID,
				WorkflowLabel: StubWorkflowLabel,
				NodeRoleID:    roleID,
				NodeLabel:     n.Label,
				UIBundleURL:   "/api/v1/nodes/" + n.ID,
			})
		}
	}

	sort.Slice(result.Consoles, func(i, j int) bool {
		return result.Consoles[i].NodeLabel < result.Consoles[j].NodeLabel
	})
	return result, nil
}

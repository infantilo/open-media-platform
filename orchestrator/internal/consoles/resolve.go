package consoles

import "sort"

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

// Resolver löst Rollenbindungen für einen Stub-Nutzer gegen die aktuell
// bekannten Nodes auf.
type Resolver struct {
	store *Store
}

// NewResolver erstellt einen Resolver, der Bindungen aus store liest.
func NewResolver(store *Store) *Resolver {
	return &Resolver{store: store}
}

// nodeRoleID ist die stabile "Rolle" eines Nodes: die vom Instanz-
// Launcher vergebene Instanz-ID (UMSETZUNG.md C8, überlebt Node-
// Neustarts — anders als die pro Prozessstart neu erzeugte IS-04-
// Node-ID), ersatzweise die rohe Node-ID für manuell (nicht über den
// Launcher) gestartete Nodes.
func nodeRoleID(n NodeInfo) string {
	if n.InstanceID != "" {
		return n.InstanceID
	}
	return n.ID
}

// Resolve wertet alle Bindungen für userID gegen nodes aus.
func (r *Resolver) Resolve(userID string, nodes []NodeInfo) (Result, error) {
	bindings, err := r.store.Load()
	if err != nil {
		return Result{}, err
	}

	seen := make(map[string]bool, len(nodes))
	var result Result
	for _, b := range bindings {
		if b.UserID != userID {
			continue
		}
		if b.Verb == VerbConfigure || b.Verb == VerbAdmin {
			result.HasEngineeringAccess = true
		}
		if b.Verb != VerbOperate {
			continue
		}
		for _, n := range nodes {
			roleID := nodeRoleID(n)
			if b.NodeID != "*" && b.NodeID != roleID {
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

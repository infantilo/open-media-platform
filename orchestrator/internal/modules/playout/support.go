package playout

import (
	"encoding/json"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Kleine Hilfen und die schmalen Sichten auf Kerndienste, die das Playout-Modul braucht (es kennt weder `httpapi` noch den
// ganzen Launcher).

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func logDomainAudit(l module.DomainAudit, actor, objectType, objectID, action string, details map[string]any) {
	if l != nil {
		l.Log(actor, objectType, objectID, action, details)
	}
}

// principal: der angemeldete Nutzer einer Anfrage (nur der Name wird gebraucht).
type principal struct{ Username string }

func principalFromContext(r *http.Request) (principal, bool) {
	u, ok := module.User(r)
	return principal{Username: u}, ok
}

// LauncherService ist, was Preflight vom Launcher braucht: die Instanzen (Label → Host/Typ) und optional die Host-Prüfung.
type LauncherService interface {
	List() []launcher.Instance
}

// NodeOptionValues liefert die gesetzten Werte der Node-Optionen (Typ-/Instanz-Ebene).
type NodeOptionValues interface {
	Values(scope, subject string) (map[string]string, error)
}

type hostPathChecker interface {
	CheckPathOnHost(hostID, path, kind string) (nodeoptions.PathInfo, error)
}

type nodeOptionSource interface {
	NodeOptions(nodeType string) []nodeoptions.Option
}

// NodeLister: Node-Auskunft (Instanz-ID zu einer Node-ID) für den Mitschnitt manueller Eingriffe.
type NodeLister interface {
	Get(id string) (registry.NodeView, bool)
}

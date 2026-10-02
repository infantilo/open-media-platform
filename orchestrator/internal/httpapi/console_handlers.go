package httpapi

import (
	"net/http"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// handleMeConsoles liefert GET /api/v1/me/consoles (ARCHITECTURE.md
// §14): die für den authentifizierten Nutzer (UMSETZUNG.md D3 Teil 2,
// vorher ein spoofbarer Stub-Header, s. docs/decisions.md D3 Teil 2)
// aufgelösten Konsolen-Einträge plus das Engineering-Zugriffssignal, mit
// dem die Shell zwischen Flow-Editor und Console-Ansicht entscheidet.
// Läuft hinter authGate.requireAuth (server.go) — im Bootstrap-Modus
// (noch kein Nutzer angelegt) liefert principalFromContext ok=false, die
// leere Username wertet Resolve zu "keine Bindung" aus, was die Shell
// wie vor D3 auf die Engineering-Ansicht zurückfallen lässt.
func handleMeConsoles(nodes NodeLister, resolver ConsoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := principalFromContext(r)
		result, err := resolver.Resolve(p.Username, nodeInfosFrom(nodes))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

// upcomingHorizon: wie weit voraus geplante Starts gemeldet werden.
const upcomingHorizon = 7 * 24 * time.Hour

// operatorWorkflowLister ist die optionale Fähigkeit des Rechte-Speichers
// (implementiert von *authz.Store), die Workflows eines Nutzers zu nennen.
type operatorWorkflowLister interface {
	WorkflowIDsFor(subject string, minVerb authz.Verb) ([]string, error)
}

type upcomingStart struct {
	WorkflowID   string    `json:"workflowId"`
	WorkflowName string    `json:"workflowName"`
	StartsAt     time.Time `json:"startsAt"`
}

// handleMeUpcoming liefert GET /api/v1/me/upcoming: die nächsten geplanten
// STARTS (Scheduler-Zeitpläne) der noch nicht laufenden Workflows, die der
// Nutzer bedienen darf — frühester zuerst. Grundlage des Countdowns, den ein
// Operator sieht, solange er noch nichts bedienen kann. Gibt nur Name und
// Zeitpunkt preis, nichts über Aufbau/Rollen des Workflows.
func handleMeUpcoming(svc WorkflowService, authzStore AuthzChecker, now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := []upcomingStart{}
		p, ok := principalFromContext(r)
		lister, canList := authzStore.(operatorWorkflowLister)
		if !ok || p.Username == "" || !canList || svc == nil {
			writeJSON(w, http.StatusOK, out)
			return
		}
		ids, err := lister.WorkflowIDsFor(p.Username, authz.VerbOperate)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		allowed := map[string]bool{}
		for _, id := range ids {
			allowed[id] = true
		}
		list, err := svc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		t := now()
		for _, wf := range list {
			if !allowed[wf.ID] || !orgMatches(r, wf.OwnerOrgID) {
				continue
			}
			if wf.Status == workflows.StatusStarted || wf.Status == workflows.StatusStarting {
				continue // läuft schon — dann erscheint die Konsole selbst
			}
			if at, ok := workflows.NextStart(wf, t, upcomingHorizon); ok {
				out = append(out, upcomingStart{WorkflowID: wf.ID, WorkflowName: wf.Name, StartsAt: at})
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].StartsAt.Before(out[j].StartsAt) })
		writeJSON(w, http.StatusOK, out)
	}
}

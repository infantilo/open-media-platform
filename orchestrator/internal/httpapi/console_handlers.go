package httpapi

import "net/http"

// stubUserHeader/-Param: es gibt noch keine echte Anmeldung (D3 folgt
// erst später) — der Stub liest den "eingeloggten" Nutzer aus einem
// Header oder Query-Param, Default "admin" (bewahrt das heutige
// Verhalten: ohne jede Rollenbindung landet die Shell weiterhin auf der
// Engineering-Ansicht, s. handleMeConsoles). Bewusst trivial
// spoofbar/nicht sicherheitsrelevant — reine UX-Weiche für die Console-
// Ansicht (UMSETZUNG.md C13), keine Zugriffskontrolle.
const stubUserHeader = "X-OMP-Stub-User"

func stubUserID(r *http.Request) string {
	if v := r.Header.Get(stubUserHeader); v != "" {
		return v
	}
	if v := r.URL.Query().Get("user"); v != "" {
		return v
	}
	return "admin"
}

// handleMeConsoles liefert GET /api/v1/me/consoles (ARCHITECTURE.md
// §14): die für den Stub-Nutzer aufgelösten Konsolen-Einträge plus das
// Engineering-Zugriffssignal, mit dem die Shell zwischen Flow-Editor und
// Console-Ansicht entscheidet.
func handleMeConsoles(nodes NodeLister, resolver ConsoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, err := resolver.Resolve(stubUserID(r), nodeInfosFrom(nodes))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

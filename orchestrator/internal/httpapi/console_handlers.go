package httpapi

import "net/http"

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

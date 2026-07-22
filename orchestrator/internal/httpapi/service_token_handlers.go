package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"
)

// handleIssueServiceToken (ARCHITECTURE.md §24.1, UMSETZUNG.md C16):
// eine vom Orchestrator lokal gestartete Instanz (Prozess oder Podman-
// Container) tauscht ihr eigenes, nur ihr per OMP_LAUNCH_SECRET
// mitgegebenes Secret gegen ein Bearer-Token, mit dem sie anschließend
// den generischen Node-Proxy (statt eines direkten Node-zu-Node-
// Zugriffs) ansprechen kann. Bewusst außerhalb von authGate — die
// Instanz hat zu diesem Zeitpunkt noch keine Nutzer-Anmeldung, das
// Secret selbst ist der Nachweis (gleiches Prinzip wie
// handleRegisterHost mit dem Host-Bootstrap-Token).
//
// Nur für lokal gestartete Instanzen: launcherSvc.Get liefert für
// Remote-Host-Agent-Instanzen (S3) kein LaunchSecret (launcher.go-Doku)
// — der Aufruf scheitert dann mit 403, keine stillschweigende Lücke.
func handleIssueServiceToken(launcherSvc LauncherService, authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var req serviceTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LaunchSecret == "" {
			http.Error(w, "launchSecret required", http.StatusBadRequest)
			return
		}

		inst, ok := launcherSvc.Get(id)
		if !ok {
			http.Error(w, "unknown instance", http.StatusNotFound)
			return
		}
		if inst.LaunchSecret == "" ||
			subtle.ConstantTimeCompare([]byte(inst.LaunchSecret), []byte(req.LaunchSecret)) != 1 {
			http.Error(w, "invalid launch secret", http.StatusForbidden)
			return
		}

		token, expiresAt, err := authSvc.IssueServiceToken(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, serviceTokenResponse{Token: token, ExpiresAt: expiresAt})
	}
}

type serviceTokenRequest struct {
	LaunchSecret string `json:"launchSecret"`
}

type serviceTokenResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

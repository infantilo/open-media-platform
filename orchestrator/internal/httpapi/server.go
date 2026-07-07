// Package httpapi stellt den HTTP-Handler des Orchestrators bereit:
// generische REST-Endpunkte plus statisches Ausliefern der UI-Shell.
package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
)

// AppName identifiziert den Orchestrator in /api/v1/info und Logs.
const AppName = "openmediaplatform-orchestrator"

// Version wird in späteren Schritten per ldflags beim Build gesetzt.
var Version = "dev"

// InfoResponse ist der Body von GET /api/v1/info.
type InfoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// NewHandler baut den kompletten HTTP-Handler des Orchestrators:
// /healthz, /api/v1/info und statisches Serving von cfg.UIDir unter /.
func NewHandler(cfg config.Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /api/v1/info", handleInfo)
	mux.Handle("/", http.FileServer(http.Dir(cfg.UIDir)))
	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, InfoResponse{Name: AppName, Version: Version})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

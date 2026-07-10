package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// handleCatalog liefert GET /api/v1/catalog (UMSETZUNG.md C8).
func handleCatalog(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.Catalog())
	}
}

// handleListInstances liefert GET /api/v1/instances.
func handleListInstances(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.List())
	}
}

// handlePostInstance liefert POST /api/v1/instances: {"type":
// "<catalogType>"} startet eine neue Instanz.
func handlePostInstance(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type string `json:"type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		inst, err := svc.Start(body.Type)
		if err != nil {
			writeLauncherError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inst)
	}
}

// handleDeleteInstance liefert DELETE /api/v1/instances/<id>.
func handleDeleteInstance(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Stop(r.PathValue("id")); err != nil {
			writeLauncherError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeLauncherError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, launcher.ErrUnknownType), errors.Is(err, launcher.ErrUnknownInstance):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, launcher.ErrUnsupportedRunner):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

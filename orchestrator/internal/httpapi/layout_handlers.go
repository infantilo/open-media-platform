package httpapi

import (
	"errors"
	"io"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
)

// handleGetLayout liefert GET /api/v1/layouts/<name> (UMSETZUNG.md B5).
func handleGetLayout(store LayoutStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := store.Get(r.PathValue("name"))
		switch {
		case errors.Is(err, layouts.ErrNotFound):
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		case errors.Is(err, layouts.ErrInvalidName):
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		case err != nil:
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	}
}

// handlePutLayout liefert PUT /api/v1/layouts/<name>: der Body wird
// unverändert (als opakes JSON) gespeichert.
func handlePutLayout(store LayoutStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

		if err := store.Put(r.PathValue("name"), body); err != nil {
			if errors.Is(err, layouts.ErrInvalidName) || errors.Is(err, layouts.ErrInvalidJSON) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

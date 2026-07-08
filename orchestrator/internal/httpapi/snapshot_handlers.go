package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
)

// handleListSnapshots liefert GET /api/v1/snapshots (UMSETZUNG.md B7,
// für die "laden"-Liste der Snapshot-Leiste).
func handleListSnapshots(svc SnapshotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateSnapshot liefert POST /api/v1/snapshots: {"label": "..."}
// erfasst Kanten + alle schreibbaren Parameterwerte aller Nodes.
func handleCreateSnapshot(svc SnapshotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Label string `json:"label"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		snap, err := svc.Create(r.Context(), body.Label)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, snap)
	}
}

// handleApplySnapshot liefert POST /api/v1/snapshots/<id>/apply.
func handleApplySnapshot(svc SnapshotService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, err := svc.Apply(r.Context(), r.PathValue("id"))
		if errors.Is(err, snapshots.ErrNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

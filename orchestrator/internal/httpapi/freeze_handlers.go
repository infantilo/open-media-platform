package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/freeze"
)

// „Letzte Minuten einfrieren“ (UMSETZUNG.md Kap. 72.10).

// WithFreeze aktiviert POST/GET /api/v1/freezes, den Download und das Löschen.
func WithFreeze(f *freeze.Freezer, s *freeze.Store) HandlerOption {
	return func(o *handlerOptions) { o.freezer, o.freezeStore = f, s }
}

const freezeCooldown = 10 * time.Second // ein Doppelklick ist eine Momentaufnahme

type createFreezeRequest struct {
	Minutes int      `json:"minutes"`
	Note    string   `json:"note"`
	NodeIDs []string `json:"nodeIds"`
}

// handleCreateFreeze: POST /api/v1/freezes {"minutes": 10, "note": "…", "nodeIds": ["…"]} — Bedienrecht genügt; die Antwort enthält nie den Inhalt.
func handleCreateFreeze(f *freeze.Freezer) http.HandlerFunc {
	var mu sync.Mutex
	last := map[string]time.Time{}
	return func(w http.ResponseWriter, r *http.Request) {
		var req createFreezeRequest
		if r.Body != nil {
			_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req)
		}
		by := currentUser(r)
		mu.Lock()
		dup := time.Since(last[by]) < freezeCooldown
		if !dup {
			last[by] = time.Now()
		}
		mu.Unlock()
		if dup {
			http.Error(w, "a snapshot was just taken — wait a few seconds", http.StatusTooManyRequests)
			return
		}
		if len(req.NodeIDs) > 50 {
			req.NodeIDs = req.NodeIDs[:50]
		}
		m, err := f.Freeze(r.Context(), freeze.Request{By: by, Trigger: "manual", Note: req.Note, Window: time.Duration(req.Minutes) * time.Minute, Scope: req.NodeIDs})
		switch {
		case errors.Is(err, freeze.ErrTooLarge):
			http.Error(w, "snapshot too large to store — choose a shorter period or fewer nodes", http.StatusRequestEntityTooLarge)
			return
		case err != nil:
			http.Error(w, "failed to create snapshot", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, m)
	}
}

// handleListFreezes: GET /api/v1/freezes — nur Beschreibungen, nie der Inhalt.
func handleListFreezes(s *freeze.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := s.List(r.Context(), 100)
		if err != nil {
			http.Error(w, "failed to list snapshots", http.StatusInternalServerError)
			return
		}
		if list == nil {
			list = []freeze.Meta{}
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleDownloadFreeze: GET /api/v1/freezes/{id}/download — das ZIP.
func handleDownloadFreeze(s *freeze.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m, data, err := s.Get(r.Context(), r.PathValue("id"))
		if errors.Is(err, freeze.ErrUnknown) {
			http.Error(w, "snapshot not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to read snapshot", http.StatusInternalServerError)
			return
		}
		name := "omp-freeze-" + m.CreatedAt.Format("20060102-150405") + "-" + sanitizeFileName(m.ID) + ".zip"
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	}
}

// handleDeleteFreeze: DELETE /api/v1/freezes/{id}.
func handleDeleteFreeze(s *freeze.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := s.Delete(r.Context(), r.PathValue("id"))
		if errors.Is(err, freeze.ErrUnknown) {
			http.Error(w, "snapshot not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to delete snapshot", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// freezeDownloadPath: /api/v1/freezes/<id>/download (für die Positivliste des Support-Zugangs).
func freezeDownloadPath(path string) bool {
	rest, ok := strings.CutPrefix(path, "/api/v1/freezes/")
	if !ok {
		return false
	}
	id, ok := strings.CutSuffix(rest, "/download")
	return ok && id != "" && !strings.Contains(id, "/")
}

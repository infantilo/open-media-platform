package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/freeze"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support/analyze"
)

// Auswertung von Support-Paket und Momentaufnahme (UMSETZUNG.md Kap. 73).

const maxAnalyzeUpload = 128 << 20

func writeAnalysis(w http.ResponseWriter, r *http.Request, data []byte) {
	lang := r.URL.Query().Get("lang")
	rep, err := analyze.Analyze(data, lang)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Query().Get("format") == "md" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = io.WriteString(w, analyze.Markdown(rep, lang))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rep)
}

// handleAnalyzeUpload: POST /api/v1/admin/support/analyze — Body ist das ZIP; ?format=md liefert den Textbericht, ?lang=en englisch.
func handleAnalyzeUpload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAnalyzeUpload))
		if err != nil {
			http.Error(w, "upload too large or interrupted", http.StatusRequestEntityTooLarge)
			return
		}
		writeAnalysis(w, r, data)
	}
}

// handleAnalyzeFreeze: GET /api/v1/freezes/{id}/analysis.
func handleAnalyzeFreeze(s *freeze.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, data, err := s.Get(r.Context(), r.PathValue("id"))
		if errors.Is(err, freeze.ErrUnknown) {
			http.Error(w, "snapshot not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to read snapshot", http.StatusInternalServerError)
			return
		}
		writeAnalysis(w, r, data)
	}
}

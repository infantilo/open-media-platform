package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// handleListWorkflows liefert GET /api/v1/workflows (ARCHITECTURE.md
// §6.2, UMSETZUNG.md D7 Teil 1).
func handleListWorkflows(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleGetWorkflow liefert GET /api/v1/workflows/{id}.
func handleGetWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wf, err := svc.Get(r.PathValue("id"))
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handleCreateWorkflow liefert POST /api/v1/workflows:
// {"name": "...", "definition": {"roles": [...], "connections": [...]}}.
func handleCreateWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name       string               `json:"name"`
			Definition workflows.Definition `json:"definition"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		wf, err := svc.Create(body.Name, body.Definition)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handleUpdateWorkflow liefert PUT /api/v1/workflows/{id} — nur im
// Zustand "stopped" (s. workflows.Service.Update, Kapitel 12 Teil 1).
// Gleicher Body wie POST /api/v1/workflows.
func handleUpdateWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name       string               `json:"name"`
			Definition workflows.Definition `json:"definition"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		wf, err := svc.Update(r.PathValue("id"), body.Name, body.Definition)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handleDeleteWorkflow liefert DELETE /api/v1/workflows/{id} — nur im
// Zustand "stopped" (s. workflows.Service.Delete).
func handleDeleteWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Delete(r.PathValue("id")); err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleStartWorkflow liefert POST /api/v1/workflows/{id}/start —
// provisioniert alle Rollen im Hintergrund (s. workflows.Service.Start),
// die Antwort trägt bereits den Zwischenzustand "starting", nicht das
// Endergebnis; Fortschritt per GET /api/v1/workflows/{id} oder SSE
// ("workflow.updated").
func handleStartWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.Start(r.Context(), id); err != nil {
			writeWorkflowError(w, err)
			return
		}
		wf, err := svc.Get(id)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handleStopWorkflow liefert POST /api/v1/workflows/{id}/stop — analog
// zu handleStartWorkflow asynchron, liefert den Zwischenzustand
// "stopping". Body optional: {"confirm": true} (D7 Teil 2,
// ARCHITECTURE.md §6.2 Punkt 2) — nur nötig, wenn der Workflow
// `settings.confirmStop` gesetzt hat; ein leerer Body entspricht
// confirm=false (unverändertes Verhalten für alle Workflows ohne
// confirm_stop).
func handleStopWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var body struct {
			Confirm bool `json:"confirm"`
		}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		if err := svc.Stop(r.Context(), id, body.Confirm); err != nil {
			writeWorkflowError(w, err)
			return
		}
		wf, err := svc.Get(id)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handlePauseWorkflow liefert POST /api/v1/workflows/{id}/pause
// (Kapitel 12 Teil 3, §12.3c) — analog zu handleStopWorkflow, gleiches
// optionales {"confirm": true} für confirm_stop (gilt identisch für
// Pause, s. workflows.Service.Pause).
func handlePauseWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var body struct {
			Confirm bool `json:"confirm"`
		}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		if err := svc.Pause(r.Context(), id, body.Confirm); err != nil {
			writeWorkflowError(w, err)
			return
		}
		wf, err := svc.Get(id)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// handleExportWorkflow liefert GET /api/v1/workflows/{id}/export
// (Kapitel 12 Teil 3, §12.3d) — in jedem Zustand abrufbar.
func handleExportWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		exported, err := svc.Export(r.PathValue("id"))
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, exported)
	}
}

// handleImportWorkflow liefert POST /api/v1/workflows/import — Body ist
// exakt das von handleExportWorkflow gelieferte Format. Legt immer
// einen neuen, gestoppten Workflow an (kein Überschreiben eines
// bestehenden).
func handleImportWorkflow(svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body workflows.ExportedWorkflow
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		wf, err := svc.Import(body)
		if err != nil {
			writeWorkflowError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

func writeWorkflowError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, workflows.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, workflows.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, workflows.ErrNotStopped), errors.Is(err, workflows.ErrNotRunning), errors.Is(err, workflows.ErrConfirmationRequired):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, workflows.ErrResourcesUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// ---- ProcessDefinition -------------------------------------------------------------------------

// handleListProcessDefinitions liefert GET /api/v1/process-definitions.
func handleListProcessDefinitions(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListDefinitions()
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleGetProcessDefinition liefert GET /api/v1/process-definitions/{id}.
func handleGetProcessDefinition(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pd, err := svc.GetDefinition(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, pd)
	}
}

// handleCreateProcessDefinition liefert POST /api/v1/process-definitions:
// {"name": "...", "description": "...", "category": "..."}.
func handleCreateProcessDefinition(svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		pd, err := svc.CreateDefinition(body.Name, body.Description, body.Category, createdBy)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "process_definition", pd.ID, "created", map[string]any{"name": pd.Name})
		writeJSON(w, http.StatusOK, pd)
	}
}

// handleUpdateProcessDefinition liefert PUT /api/v1/process-definitions/{id}
// — gleicher Body wie POST, ändert nur Metadaten (s.
// process.Store.UpdateDefinitionMeta-Doku: Versionen bleiben davon
// unberührt).
func handleUpdateProcessDefinition(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		pd, err := svc.UpdateDefinitionMeta(r.PathValue("id"), body.Name, body.Description, body.Category)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, pd)
	}
}

// ---- ProcessVersion -----------------------------------------------------------------------------

// handleListProcessVersions liefert GET
// /api/v1/process-definitions/{id}/versions.
func handleListProcessVersions(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListVersions(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateProcessVersion liefert POST
// /api/v1/process-definitions/{id}/versions — Body ist eine
// process.Definition (Step-Graph, A1/A7). Neue Versionen starten immer
// im Status "draft" (s. Store.CreateVersion) — erst
// handlePublishProcessVersion macht sie über POST
// /api/v1/process-executions startbar.
func handleCreateProcessVersion(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var def process.Definition
		if err := json.NewDecoder(r.Body).Decode(&def); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		v, err := svc.CreateVersion(r.PathValue("id"), def, createdBy)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// handleGetProcessVersion liefert GET /api/v1/process-versions/{id}.
func handleGetProcessVersion(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.GetVersion(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// handlePublishProcessVersion liefert POST
// /api/v1/process-versions/{id}/publish (A7: draft -> published, macht
// die Version über POST /api/v1/process-executions startbar).
func handlePublishProcessVersion(svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.PublishVersion(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_version", v.ID, "published", map[string]any{"processDefinitionId": v.ProcessDefinitionID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// handleDeprecateProcessVersion liefert POST
// /api/v1/process-versions/{id}/deprecate.
func handleDeprecateProcessVersion(svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.DeprecateVersion(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_version", v.ID, "deprecated", map[string]any{"processDefinitionId": v.ProcessDefinitionID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// handleArchiveProcessVersion liefert POST
// /api/v1/process-versions/{id}/archive.
func handleArchiveProcessVersion(svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.ArchiveVersion(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_version", v.ID, "archived", map[string]any{"processDefinitionId": v.ProcessDefinitionID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// ---- ProcessExecution ---------------------------------------------------------------------------

// handleListProcessExecutions liefert GET /api/v1/process-executions —
// Filter über Query-Parameter (alle optional, kombinierbar):
// ?processDefinitionId=&status=&correlationId=&parentExecutionId=.
func handleListProcessExecutions(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		list, err := svc.ListExecutions(process.ExecutionFilter{
			ProcessDefinitionID: q.Get("processDefinitionId"),
			Status:              q.Get("status"),
			CorrelationID:       q.Get("correlationId"),
			ParentExecutionID:   q.Get("parentExecutionId"),
		})
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleStartProcessExecution liefert POST /api/v1/process-executions:
// {"processDefinitionId": "...", "processVersionId": "...",
// "correlationId": "...", "causationId": "...", "parentExecutionId":
// "...", "traceId": "...", "input": {...}}. correlationId leer = wird
// auf die neue Execution-ID gesetzt (s. Store.CreateExecution-Doku).
func handleStartProcessExecution(engine ProcessEngineService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ProcessDefinitionID string          `json:"processDefinitionId"`
			ProcessVersionID    string          `json:"processVersionId"`
			CorrelationID       string          `json:"correlationId"`
			CausationID         string          `json:"causationId"`
			ParentExecutionID   string          `json:"parentExecutionId"`
			TraceID             string          `json:"traceId"`
			Input               json.RawMessage `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		exec, err := engine.Start(process.CreateExecutionParams{
			ProcessDefinitionID: body.ProcessDefinitionID,
			ProcessVersionID:    body.ProcessVersionID,
			CorrelationID:       body.CorrelationID,
			CausationID:         body.CausationID,
			ParentExecutionID:   body.ParentExecutionID,
			TraceID:             body.TraceID,
			CreatedBy:           createdBy,
			Input:               body.Input,
		})
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "process_execution", exec.ID, "started", map[string]any{"processDefinitionId": exec.ProcessDefinitionID, "processVersionId": exec.ProcessVersionID, "correlationId": exec.CorrelationID})
		writeJSON(w, http.StatusOK, exec)
	}
}

// handleGetProcessExecution liefert GET /api/v1/process-executions/{id}.
func handleGetProcessExecution(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		exec, err := svc.GetExecution(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, exec)
	}
}

// handleListProcessStepExecutions liefert GET
// /api/v1/process-executions/{id}/steps.
func handleListProcessStepExecutions(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		steps, err := svc.ListStepExecutions(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, steps)
	}
}

// handleCancelProcessExecution liefert POST
// /api/v1/process-executions/{id}/cancel.
func handleCancelProcessExecution(engine ProcessEngineService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		exec, err := engine.Cancel(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_execution", exec.ID, "cancelled", nil)
		writeJSON(w, http.StatusOK, exec)
	}
}

// handlePauseProcessExecution liefert POST
// /api/v1/process-executions/{id}/pause.
func handlePauseProcessExecution(engine ProcessEngineService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		exec, err := engine.Pause(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, exec)
	}
}

// handleResumeProcessExecution liefert POST
// /api/v1/process-executions/{id}/resume.
func handleResumeProcessExecution(engine ProcessEngineService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		exec, err := engine.Resume(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, exec)
	}
}

// ---- HumanTask ------------------------------------------------------------------------------------

// handleListHumanTasksByExecution liefert GET
// /api/v1/process-executions/{id}/human-tasks.
func handleListHumanTasksByExecution(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListHumanTasksByExecution(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleListHumanTasksByAssignee liefert GET /api/v1/human-tasks —
// ?assignee=... ist PFLICHT (kein "alle HumanTasks"-Modus: die
// Aufgabenstellung beschreibt HumanTask-Listen immer pro Zuständigem,
// ein ungefiltertes "alle" wäre eine andere, hier nicht gebaute
// Fähigkeit — s. auch /api/v1/process-executions/{id}/human-tasks für
// den execution-gescopten Fall).
func handleListHumanTasksByAssignee(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		assignee := r.URL.Query().Get("assignee")
		if assignee == "" {
			http.Error(w, "assignee query parameter is required", http.StatusBadRequest)
			return
		}
		list, err := svc.ListHumanTasksByAssignee(assignee)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleGetHumanTask liefert GET /api/v1/human-tasks/{id}.
func handleGetHumanTask(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		task, err := svc.GetHumanTask(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, task)
	}
}

// handleAssignHumanTask liefert POST /api/v1/human-tasks/{id}/assign:
// {"assignee": "..."} (pending -> claimed, A6).
func handleAssignHumanTask(svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Assignee string `json:"assignee"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		task, err := svc.AssignHumanTask(r.PathValue("id"), body.Assignee)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "human_task", task.ID, "assigned", map[string]any{"assignee": task.Assignee})
		writeJSON(w, http.StatusOK, task)
	}
}

// handleCompleteHumanTask liefert POST
// /api/v1/human-tasks/{id}/complete: {"expectedRowVersion": N,
// "status": "approved"|"rejected"|"changes_requested"|"cancelled"|...,
// "decision": "...", "comment": "..."} — status ist jeder gültige
// HumanTaskTransitions-Zielzustand (A3 optimistic concurrency über
// expectedRowVersion, A6). Die Engine (nicht der Store direkt)
// entscheidet, weil ein abgeschlossener HumanTask/Approval-Schritt den
// wartenden Ausführungszyklus wieder anstößt (s.
// Engine.CompleteHumanTask-Doku).
func handleCompleteHumanTask(engine ProcessEngineService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ExpectedRowVersion int    `json:"expectedRowVersion"`
			Status             string `json:"status"`
			Decision           string `json:"decision"`
			Comment            string `json:"comment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		task, err := engine.CompleteHumanTask(r.PathValue("id"), body.ExpectedRowVersion, body.Status, body.Decision, body.Comment)
		if err != nil {
			writeProcessError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "human_task", task.ID, "completed", map[string]any{"status": task.Status, "decision": task.Decision, "comment": task.Comment})
		writeJSON(w, http.StatusOK, task)
	}
}

// writeProcessError bildet die process/statemachine-Fehlersorten auf
// HTTP-Status ab — gleiches Muster wie writeWorkflowError.
// ErrConcurrentModification/ErrInvalidTransition/ErrVersionNotPublished
// werden bewusst alle als 409 gemeldet (Zustands-Vorbedingung verletzt,
// nicht die Anfrageform selbst): der Aufrufer soll den aktuellen Stand
// neu lesen (GET) und entscheiden, ob ein erneuter Versuch sinnvoll
// ist, nicht blind wiederholen.
func writeProcessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, process.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, process.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, process.ErrConcurrentModification),
		errors.Is(err, process.ErrVersionNotPublished),
		errors.Is(err, statemachine.ErrInvalidTransition):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// WithScriptCommands meldet die Namen der Script-Allow-Liste (main.go,
// per exec.LookPath ermittelt) für GET /api/v1/process-capabilities —
// nur Namen, nie Pfade.
func WithScriptCommands(names []string) HandlerOption {
	return func(o *handlerOptions) { o.scriptCommands = names }
}

// handleProcessCapabilities liefert GET /api/v1/process-capabilities:
// welche Step-Typen tatsächlich einen Executor haben und welche Script-
// Kommandos erlaubt sind (Nachtrag 270) — der grafische Editor markiert
// damit nicht ausführbare Typen und bietet Kommandos als Auswahl statt
// als Freitext an.
func handleProcessCapabilities(engine ProcessEngineService, scriptCommands []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cmds := append([]string{}, scriptCommands...)
		sort.Strings(cmds)
		writeJSON(w, http.StatusOK, map[string]any{
			"stepTypes":      engine.StepTypes(),
			"scriptCommands": cmds,
		})
	}
}

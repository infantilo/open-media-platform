package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
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
		// Kapitel 21 B14: nur die eigene Organisation, s. org_enforcement.go.
		visible := make([]process.ProcessDefinition, 0, len(list))
		for _, pd := range list {
			if orgMatches(r, pd.OwnerOrgID) {
				visible = append(visible, pd)
			}
		}
		writeJSON(w, http.StatusOK, visible)
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
		if !orgMatches(r, pd.OwnerOrgID) {
			writeOrgNotFound(w)
			return
		}
		writeJSON(w, http.StatusOK, pd)
	}
}

// processDefinitionOrgGuard liest die ProcessDefinition und lehnt mit
// 404 ab, wenn sie einer fremden Organisation gehört (Kapitel 21 B14)
// — s. workflowOrgGuard in workflow_handlers.go, identisches Muster.
func processDefinitionOrgGuard(w http.ResponseWriter, r *http.Request, svc ProcessStoreService, id string) bool {
	pd, err := svc.GetDefinition(id)
	if err != nil {
		writeProcessError(w, err)
		return false
	}
	if !orgMatches(r, pd.OwnerOrgID) {
		writeOrgNotFound(w)
		return false
	}
	return true
}

// processVersionOrgGuard/processExecutionOrgGuard/humanTaskOrgGuard
// (Kapitel 21 B14, UMSETZUNG.md §21.6 Phase 3: "nested/derived
// entities... derive org via parent") — ProcessVersion/ProcessExecution/
// HumanTask tragen selbst KEIN OwnerOrgID (bewusste Entscheidung, s.
// dortige Doku): die zugehörige Organisation ergibt sich über die
// Elternkette bis zur ProcessDefinition, die einzige Stelle mit einem
// echten OwnerOrgID-Feld in dieser Domäne.
func processVersionOrgGuard(w http.ResponseWriter, r *http.Request, svc ProcessStoreService, id string) (process.ProcessVersion, bool) {
	v, err := svc.GetVersion(id)
	if err != nil {
		writeProcessError(w, err)
		return process.ProcessVersion{}, false
	}
	pd, err := svc.GetDefinition(v.ProcessDefinitionID)
	if err != nil {
		writeProcessError(w, err)
		return process.ProcessVersion{}, false
	}
	if !orgMatches(r, pd.OwnerOrgID) {
		writeOrgNotFound(w)
		return process.ProcessVersion{}, false
	}
	return v, true
}

func processExecutionOrgGuard(w http.ResponseWriter, r *http.Request, svc ProcessStoreService, id string) (process.ProcessExecution, bool) {
	exec, err := svc.GetExecution(id)
	if err != nil {
		writeProcessError(w, err)
		return process.ProcessExecution{}, false
	}
	pd, err := svc.GetDefinition(exec.ProcessDefinitionID)
	if err != nil {
		writeProcessError(w, err)
		return process.ProcessExecution{}, false
	}
	if !orgMatches(r, pd.OwnerOrgID) {
		writeOrgNotFound(w)
		return process.ProcessExecution{}, false
	}
	return exec, true
}

func humanTaskOrgGuard(w http.ResponseWriter, r *http.Request, svc ProcessStoreService, task process.HumanTask) bool {
	exec, err := svc.GetExecution(task.ProcessExecutionID)
	if err != nil {
		writeProcessError(w, err)
		return false
	}
	pd, err := svc.GetDefinition(exec.ProcessDefinitionID)
	if err != nil {
		writeProcessError(w, err)
		return false
	}
	if !orgMatches(r, pd.OwnerOrgID) {
		writeOrgNotFound(w)
		return false
	}
	return true
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
		pd, err := svc.CreateDefinition(body.Name, body.Description, body.Category, createdBy, callerOrgID(r))
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
		id := r.PathValue("id")
		if !processDefinitionOrgGuard(w, r, svc, id) {
			return
		}
		pd, err := svc.UpdateDefinitionMeta(id, body.Name, body.Description, body.Category)
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
		id := r.PathValue("id")
		if !processDefinitionOrgGuard(w, r, svc, id) {
			return
		}
		list, err := svc.ListVersions(id)
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
		id := r.PathValue("id")
		if !processDefinitionOrgGuard(w, r, svc, id) {
			return
		}
		var def process.Definition
		if err := json.NewDecoder(r.Body).Decode(&def); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		v, err := svc.CreateVersion(id, def, createdBy)
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
		v, ok := processVersionOrgGuard(w, r, svc, r.PathValue("id"))
		if !ok {
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
		if _, ok := processVersionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		if _, ok := processVersionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		if _, ok := processVersionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		defID := q.Get("processDefinitionId")
		if defID != "" && !processDefinitionOrgGuard(w, r, svc, defID) {
			return
		}
		list, err := svc.ListExecutions(process.ExecutionFilter{
			ProcessDefinitionID: defID,
			Status:              q.Get("status"),
			CorrelationID:       q.Get("correlationId"),
			ParentExecutionID:   q.Get("parentExecutionId"),
		})
		if err != nil {
			writeProcessError(w, err)
			return
		}
		// Kapitel 21 B14: ohne processDefinitionId-Filter (der Guard oben
		// deckt den gefilterten Fall bereits ab) muss jede Execution einzeln
		// über ihre Definition geprüft werden — einmal alle Definitionen
		// geladen statt pro Execution eine eigene GetDefinition-Anfrage.
		if defID == "" {
			defs, err := svc.ListDefinitions()
			if err != nil {
				writeProcessError(w, err)
				return
			}
			orgByDef := make(map[string]string, len(defs))
			for _, d := range defs {
				orgByDef[d.ID] = d.OwnerOrgID
			}
			visible := make([]process.ProcessExecution, 0, len(list))
			for _, exec := range list {
				if orgMatches(r, orgByDef[exec.ProcessDefinitionID]) {
					visible = append(visible, exec)
				}
			}
			list = visible
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleStartProcessExecution liefert POST /api/v1/process-executions:
// {"processDefinitionId": "...", "processVersionId": "...",
// "correlationId": "...", "causationId": "...", "parentExecutionId":
// "...", "traceId": "...", "input": {...}}. correlationId leer = wird
// auf die neue Execution-ID gesetzt (s. Store.CreateExecution-Doku).
func handleStartProcessExecution(engine ProcessEngineService, svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
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
		if !processDefinitionOrgGuard(w, r, svc, body.ProcessDefinitionID) {
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
		exec, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id"))
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, exec)
	}
}

// handleListProcessStepExecutions liefert GET
// /api/v1/process-executions/{id}/steps.
func handleListProcessStepExecutions(svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
func handleCancelProcessExecution(engine ProcessEngineService, svc ProcessStoreService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
func handlePauseProcessExecution(engine ProcessEngineService, svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
func handleResumeProcessExecution(engine ProcessEngineService, svc ProcessStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		if _, ok := processExecutionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		if !humanTaskOrgGuard(w, r, svc, task) {
			return
		}
		writeJSON(w, http.StatusOK, task)
	}
}

// callerMayActOnHumanTask ist die Freigabe-Regel für assign/complete
// (Kapitel 21 B14, live gefunden+gefixt in Nachtrag 274: beide
// Endpunkte prüften bislang nur das GLOBALE VerbOperate, nicht ob der
// Aufrufer tatsächlich currentAssignee ist — jeder Operate-Nutzer
// konnte fremde Human-Tasks zuweisen/entscheiden). Ein noch
// UNZUGEWIESENER Task (currentAssignee == "") bleibt weiterhin für
// jeden Operate-Nutzer offen (Pool-/Rollen-Task, "Für mich
// beanspruchen" — genau der Weg, über den `assignee` erst gesetzt
// wird, s. ui/shell/process-view.ts #claimTask). Ist bereits jemand
// zugewiesen, darf NUR dieser Nutzer selbst handeln (Entscheiden,
// Freigeben/Weiterreichen über `assign` an jemand anderen) — oder ein
// Admin als Eskalations-/Vertretungsweg. Keine authz.Binding-
// Erweiterung nötig (das größere B14-Thema bleibt offen): reiner
// Datenvergleich gegen das ohnehin schon geladene HumanTask.
func callerMayActOnHumanTask(r *http.Request, authzStore AuthzChecker, currentAssignee string) bool {
	actor := actorFromRequest(r)
	if currentAssignee == "" || currentAssignee == actor {
		return true
	}
	isAdmin, err := authzStore.Check(actor, authz.AnyNode, authz.VerbAdmin)
	return err == nil && isAdmin
}

// handleAssignHumanTask liefert POST /api/v1/human-tasks/{id}/assign:
// {"assignee": "..."} (pending -> claimed, A6).
func handleAssignHumanTask(svc ProcessStoreService, authzStore AuthzChecker, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Assignee string `json:"assignee"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		current, err := svc.GetHumanTask(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		if !humanTaskOrgGuard(w, r, svc, current) {
			return
		}
		if !callerMayActOnHumanTask(r, authzStore, current.Assignee) {
			http.Error(w, "not assigned to this human task", http.StatusForbidden)
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
// Engine.CompleteHumanTask-Doku). svc wird NUR für die
// Assignee-Freigabeprüfung gebraucht (callerMayActOnHumanTask), die
// eigentliche Mutation bleibt bei engine.
func handleCompleteHumanTask(engine ProcessEngineService, svc ProcessStoreService, authzStore AuthzChecker, domainAudit DomainAuditLogger) http.HandlerFunc {
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
		current, err := svc.GetHumanTask(r.PathValue("id"))
		if err != nil {
			writeProcessError(w, err)
			return
		}
		if !humanTaskOrgGuard(w, r, svc, current) {
			return
		}
		if !callerMayActOnHumanTask(r, authzStore, current.Assignee) {
			http.Error(w, "not assigned to this human task", http.StatusForbidden)
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

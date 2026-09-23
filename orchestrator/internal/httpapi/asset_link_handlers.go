package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/assetlinks"
)

// writeAssetLinkError bildet assetlinks-Fehlersorten auf HTTP-Status ab
// — gleiches Muster wie writeProcessError/writeAssetError. Eine
// Fremdschlüssel-Verletzung (unbekannte processExecutionId/
// assetVersionId) kommt roh von Postgres, nicht als eigener Sentinel —
// 400 ist hier trotzdem treffender als 500 (Aufrufer-Fehler: erfundene
// ID), erkannt am pgx-Fehlertext statt eines eigenen Fehlertyps (kein
// zusätzlicher Postgres-Fehlercode-Import nur für diesen einen Fall).
func writeAssetLinkError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, assetlinks.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case strings.Contains(err.Error(), "foreign key constraint"):
		http.Error(w, "unknown processExecutionId or assetVersionId", http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleCreateAssetLink liefert POST
// /api/v1/process-executions/{id}/asset-links: {"assetVersionId": "...",
// "role": "input"|"output"} (B10, Nachtrag 277).
func handleCreateAssetLink(svc AssetLinkService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AssetVersionID string `json:"assetVersionId"`
			Role           string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		executionID := r.PathValue("id")
		link, err := svc.CreateLink(executionID, body.AssetVersionID, body.Role)
		if err != nil {
			writeAssetLinkError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_execution", executionID, "asset_linked", map[string]any{"assetVersionId": link.AssetVersionID, "role": link.Role})
		writeJSON(w, http.StatusOK, link)
	}
}

// handleListAssetLinksByExecution liefert GET
// /api/v1/process-executions/{id}/asset-links.
func handleListAssetLinksByExecution(svc AssetLinkService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		links, err := svc.ListByExecution(r.PathValue("id"))
		if err != nil {
			writeAssetLinkError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, links)
	}
}

// handleListAssetLinksByVersion liefert GET
// /api/v1/asset-versions/{id}/links — Rückverfolgung "welche
// Prozessläufe haben diese Version gelesen/erzeugt".
func handleListAssetLinksByVersion(svc AssetLinkService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		links, err := svc.ListByAssetVersion(r.PathValue("id"))
		if err != nil {
			writeAssetLinkError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, links)
	}
}

// handleDeleteAssetLink liefert DELETE /api/v1/asset-links/{id} —
// idempotent.
func handleDeleteAssetLink(svc AssetLinkService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.DeleteLink(id); err != nil {
			writeAssetLinkError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "process_execution_asset_link", id, "deleted", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

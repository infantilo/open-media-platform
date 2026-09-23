package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// ---- Asset --------------------------------------------------------------------------------------

// handleAssetLifecycle liefert GET /api/v1/asset-lifecycle: die
// erlaubten Asset- (B8) und AssetVersion-Übergänge (B3) als from ->
// Ziel-Liste, direkt aus asset.LifecycleTransitions/VersionTransitions —
// die UI zeigt damit nur tatsächlich erlaubte Übergänge an, ohne den
// Zustandsgraphen im Frontend zu duplizieren. Statisch, braucht keinen
// Store.
func handleAssetLifecycle() http.HandlerFunc {
	body := map[string]map[string][]string{
		"asset":   asset.LifecycleTransitions.Graph(),
		"version": asset.VersionTransitions.Graph(),
	}
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}
}

// handleListAssets liefert GET /api/v1/assets — Filter über
// Query-Parameter (beide optional, kombinierbar): ?type=&status=.
func handleListAssets(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		list, err := svc.ListAssets(asset.AssetFilter{Type: q.Get("type"), Status: q.Get("status")})
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateAsset liefert POST /api/v1/assets: {"type": "...",
// "title": "...", "description": "..."} — legt das Asset im Status
// "ingesting" an (B8, Start des Lifecycles).
func handleCreateAsset(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type        string `json:"type"`
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		a, err := svc.CreateAsset(body.Type, body.Title, body.Description, createdBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "asset", a.ID, "created", map[string]any{"type": a.Type, "title": a.Title})
		writeJSON(w, http.StatusOK, a)
	}
}

// handleGetAsset liefert GET /api/v1/assets/{id}.
func handleGetAsset(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := svc.GetAsset(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

// handleUpdateAssetStatus liefert POST /api/v1/assets/{id}/status:
// {"expectedRowVersion": N, "status": "..."} — jeder gültige
// LifecycleTransitions-Zielzustand (B8, A3 optimistic concurrency über
// expectedRowVersion). updatedBy kommt aus dem authentifizierten
// Principal, nicht aus dem Body (kein Vortäuschen fremder Urheberschaft).
func handleUpdateAssetStatus(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ExpectedRowVersion int    `json:"expectedRowVersion"`
			Status             string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		updatedBy := ""
		if p, ok := principalFromContext(r); ok {
			updatedBy = p.Username
		}
		a, err := svc.UpdateAssetStatus(r.PathValue("id"), body.ExpectedRowVersion, body.Status, updatedBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, updatedBy, "asset", a.ID, "status_changed", map[string]any{"to": a.Status})
		writeJSON(w, http.StatusOK, a)
	}
}

// handleUpdateAssetMetadata liefert PUT /api/v1/assets/{id}/metadata:
// {"expectedRowVersion": N, "metadata": {"system":{},"technical":{},
// "descriptive":{},"editorial":{},"custom":{},"ai":{}}} — ersetzt den
// kompletten Metadata-Block (kein partielles Merge, s.
// asset.Store.UpdateAssetMetadata-Doku).
func handleUpdateAssetMetadata(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ExpectedRowVersion int            `json:"expectedRowVersion"`
			Metadata           asset.Metadata `json:"metadata"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		updatedBy := ""
		if p, ok := principalFromContext(r); ok {
			updatedBy = p.Username
		}
		a, err := svc.UpdateAssetMetadata(r.PathValue("id"), body.ExpectedRowVersion, body.Metadata, updatedBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

// ---- AssetVersion ---------------------------------------------------------------------------------

// handleListAssetVersions liefert GET /api/v1/assets/{id}/versions.
func handleListAssetVersions(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListVersions(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateAssetVersion liefert POST /api/v1/assets/{id}/versions:
// {"parentVersionId": "...", "changeReason": "..."} — beide optional
// (parentVersionId leer = keine Vorgängerversion). Neue Versionen
// starten immer im Status "draft" (B3) — erst
// handlePublishAssetVersion setzt sie als current_version_id.
func handleCreateAssetVersion(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ParentVersionID string `json:"parentVersionId"`
			ChangeReason    string `json:"changeReason"`
		}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		v, err := svc.CreateVersion(r.PathValue("id"), body.ParentVersionID, body.ChangeReason, createdBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "asset_version", v.ID, "created", map[string]any{"assetId": v.AssetID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// handleGetAssetVersion liefert GET /api/v1/asset-versions/{id}.
func handleGetAssetVersion(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.GetVersion(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// handlePublishAssetVersion liefert POST
// /api/v1/asset-versions/{id}/publish (B3: draft -> published,
// unveränderlich ab hier, wird atomar zu assets.current_version_id).
func handlePublishAssetVersion(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.PublishVersion(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "asset_version", v.ID, "published", map[string]any{"assetId": v.AssetID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// handleArchiveAssetVersion liefert POST
// /api/v1/asset-versions/{id}/archive.
func handleArchiveAssetVersion(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.ArchiveVersion(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "asset_version", v.ID, "archived", map[string]any{"assetId": v.AssetID, "versionNumber": v.VersionNumber})
		writeJSON(w, http.StatusOK, v)
	}
}

// ---- Representation -------------------------------------------------------------------------------

// handleListRepresentations liefert GET
// /api/v1/asset-versions/{id}/representations.
func handleListRepresentations(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListRepresentations(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateRepresentation liefert POST
// /api/v1/asset-versions/{id}/representations — Body ist eine
// asset.Representation (B4), AssetVersionID wird aus dem Pfad
// übernommen (überschreibt ein im Body mitgeschicktes Feld — der Pfad
// ist die verbindliche Quelle, kein Aufrufer darf eine Representation
// unter einer anderen Version als der URL anlegen).
func handleCreateRepresentation(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var rep asset.Representation
		if err := json.NewDecoder(r.Body).Decode(&rep); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		rep.AssetVersionID = r.PathValue("id")
		created, err := svc.CreateRepresentation(rep)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, created)
	}
}

// handleGetRepresentation liefert GET /api/v1/representations/{id}.
func handleGetRepresentation(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rep, err := svc.GetRepresentation(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rep)
	}
}

// handleDeleteRepresentation liefert DELETE
// /api/v1/representations/{id} — idempotent (s.
// asset.Store.DeleteRepresentation-Doku).
func handleDeleteRepresentation(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.DeleteRepresentation(r.PathValue("id")); err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// writeAssetError bildet die asset/statemachine-Fehlersorten auf
// HTTP-Status ab — gleiches Muster wie writeProcessError.
func writeAssetError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, asset.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, asset.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, asset.ErrConcurrentModification), errors.Is(err, asset.ErrVersionImmutable), errors.Is(err, statemachine.ErrInvalidTransition):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// ---- Collection (B12) -----------------------------------------------------------------------------

// handleCreateCollection liefert POST /api/v1/collections: {"title":
// "...", "description": "..."}.
func handleCreateCollection(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := actorFromRequest(r)
		c, err := svc.CreateCollection(body.Title, body.Description, createdBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "collection", c.ID, "created", map[string]any{"title": c.Title})
		writeJSON(w, http.StatusOK, c)
	}
}

// handleListCollections liefert GET /api/v1/collections.
func handleListCollections(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListCollections()
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleGetCollection liefert GET /api/v1/collections/{id}.
func handleGetCollection(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := svc.GetCollection(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}

// handleUpdateCollection liefert PUT /api/v1/collections/{id}:
// {"title": "...", "description": "..."} — nur Metadaten, die
// Mitgliederliste läuft über die members-Endpunkte unten.
func handleUpdateCollection(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		c, err := svc.UpdateCollectionMeta(r.PathValue("id"), body.Title, body.Description)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "collection", c.ID, "updated", map[string]any{"title": c.Title})
		writeJSON(w, http.StatusOK, c)
	}
}

// handleDeleteCollection liefert DELETE /api/v1/collections/{id} —
// idempotent, entfernt nur die Gruppierung, die Assets selbst bleiben
// unangetastet (s. Store.DeleteCollection-Doku).
func handleDeleteCollection(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.DeleteCollection(id); err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "collection", id, "deleted", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleListCollectionMembers liefert GET
// /api/v1/collections/{id}/members — die Asset-IDs, nicht die vollen
// Asset-Objekte (dieselbe schlanke Linie wie andere ID-Listen in diesem
// Paket, z. B. Rollenbindungen) — die UI löst einzelne Assets bei
// Bedarf über GET /api/v1/assets/{id} auf.
func handleListCollectionMembers(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		members, err := svc.ListCollectionMembers(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, members)
	}
}

// handleAddCollectionMember liefert POST
// /api/v1/collections/{id}/members: {"assetId": "..."}.
func handleAddCollectionMember(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AssetID string `json:"assetId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AssetID == "" {
			http.Error(w, "assetId required", http.StatusBadRequest)
			return
		}
		collectionID := r.PathValue("id")
		if err := svc.AddCollectionMember(collectionID, body.AssetID); err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "collection", collectionID, "member_added", map[string]any{"assetId": body.AssetID})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleRemoveCollectionMember liefert DELETE
// /api/v1/collections/{id}/members/{assetId}.
func handleRemoveCollectionMember(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		collectionID := r.PathValue("id")
		assetID := r.PathValue("assetId")
		if err := svc.RemoveCollectionMember(collectionID, assetID); err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "collection", collectionID, "member_removed", map[string]any{"assetId": assetID})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// ---- AssetRelationship (B12) -----------------------------------------------------------------------

// handleCreateRelationship liefert POST /api/v1/asset-relationships:
// {"fromAssetId": "...", "toAssetId": "...", "type": "derived_from"|...}.
func handleCreateRelationship(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			FromAssetID string `json:"fromAssetId"`
			ToAssetID   string `json:"toAssetId"`
			Type        string `json:"type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := actorFromRequest(r)
		rel, err := svc.CreateRelationship(body.FromAssetID, body.ToAssetID, body.Type, createdBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "asset_relationship", rel.ID, "created", map[string]any{"fromAssetId": rel.FromAssetID, "toAssetId": rel.ToAssetID, "type": rel.Type})
		writeJSON(w, http.StatusOK, rel)
	}
}

// handleListAssetRelationships liefert GET
// /api/v1/assets/{id}/relationships — beide Richtungen, s.
// Store.ListRelationships-Doku.
func handleListAssetRelationships(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListRelationships(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleDeleteRelationship liefert DELETE
// /api/v1/asset-relationships/{id} — idempotent.
func handleDeleteRelationship(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.DeleteRelationship(id); err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "asset_relationship", id, "deleted", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

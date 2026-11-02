package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/ebucore"
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
		// Kapitel 21 B14: nur die eigene Organisation, s. org_enforcement.go.
		visible := make([]asset.Asset, 0, len(list))
		for _, a := range list {
			if orgMatches(r, a.OwnerOrgID) {
				visible = append(visible, a)
			}
		}
		writeJSON(w, http.StatusOK, visible)
	}
}

// handleSearchAssets liefert GET /api/v1/assets/search?q=... — echte
// Postgres-Volltextsuche (B11, s. asset.Store.SearchAssets-Doku) statt
// der bisherigen reinen Client-Substring-Suche. Ein leeres/fehlendes q
// liefert bewusst eine leere Liste (nicht 400) — ein Suchfeld, das beim
// Leeren zwischenzeitlich einen Request mit leerem q abfeuert, soll
// keinen Fehler-Toast auslösen, die UI fällt bei leerem q ohnehin auf
// GET /api/v1/assets zurück (s. asset-view.ts).
func handleSearchAssets(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if strings.TrimSpace(q) == "" {
			writeJSON(w, http.StatusOK, []asset.Asset{})
			return
		}
		list, err := svc.SearchAssets(q)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		// Kapitel 21 B14: nur die eigene Organisation, gleiches Muster wie
		// handleListAssets.
		visible := make([]asset.Asset, 0, len(list))
		for _, a := range list {
			if orgMatches(r, a.OwnerOrgID) {
				visible = append(visible, a)
			}
		}
		writeJSON(w, http.StatusOK, visible)
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
		a, err := svc.CreateAsset(body.Type, body.Title, body.Description, createdBy, callerOrgID(r))
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
		if !orgMatches(r, a.OwnerOrgID) {
			writeOrgNotFound(w)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

// assetOrgGuard liest das Asset und lehnt mit 404 ab, wenn es einer
// fremden Organisation gehört (Kapitel 21 B14) — s. workflowOrgGuard
// in workflow_handlers.go, identisches Muster.
func assetOrgGuard(w http.ResponseWriter, r *http.Request, svc AssetService, id string) (asset.Asset, bool) {
	a, err := svc.GetAsset(id)
	if err != nil {
		writeAssetError(w, err)
		return asset.Asset{}, false
	}
	if !orgMatches(r, a.OwnerOrgID) {
		writeOrgNotFound(w)
		return asset.Asset{}, false
	}
	return a, true
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
		id := r.PathValue("id")
		if _, ok := assetOrgGuard(w, r, svc, id); !ok {
			return
		}
		updatedBy := ""
		if p, ok := principalFromContext(r); ok {
			updatedBy = p.Username
		}
		a, err := svc.UpdateAssetStatus(id, body.ExpectedRowVersion, body.Status, updatedBy)
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
		id := r.PathValue("id")
		cur, ok := assetOrgGuard(w, r, svc, id)
		if !ok {
			return
		}
		// Registrierte Felder (Kapitel 78.1) prüfen: Typ, Auswahlliste, Pflicht.
		// Freie Schlüssel ohne Registrierung bleiben unberührt.
		fields, err := svc.ListFields(cur.Type)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		if problems := asset.ValidateMetadata(fields, body.Metadata); len(problems) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "metadata validation failed", "problems": problems})
			return
		}
		updatedBy := ""
		if p, ok := principalFromContext(r); ok {
			updatedBy = p.Username
		}
		a, err := svc.UpdateAssetMetadata(id, body.ExpectedRowVersion, body.Metadata, updatedBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

// ---- EBUCore (Kapitel 78.2, EBU Tech 3293) -------------------------------------------------------

// handleExportAssetEBUCore liefert GET /api/v1/assets/{id}/ebucore als EBUCore-XML
// (application/xml, ebucore.xsd 1.10.1) inklusive der Representations der aktuellen Version.
func handleExportAssetEBUCore(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, ok := assetOrgGuard(w, r, svc, r.PathValue("id"))
		if !ok {
			return
		}
		fields, err := svc.ListFields(a.Type)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		var reps []asset.Representation
		if a.CurrentVersionID != "" {
			if reps, err = svc.ListRepresentations(a.CurrentVersionID); err != nil {
				writeAssetError(w, err)
				return
			}
		}
		doc, err := ebucore.Export(a, reps, fields, time.Now())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+a.ID+`.ebucore.xml"`)
		_, _ = w.Write(doc)
	}
}

// handleImportAssetEBUCore liefert POST /api/v1/assets/{id}/ebucore?expectedRowVersion=N[&dryRun=1]:
// Body ist ein EBUCore-XML-Dokument. Die gelesenen Werte werden in die Metadaten gemischt (Importwert
// gewinnt je Schlüssel, übrige Schlüssel bleiben), gegen die Feld-Registry geprüft und gespeichert.
// Mit dryRun=1 wird nur gezeigt, was übernommen würde. Titel und Beschreibung des Dokuments werden
// gemeldet, aber nicht überschrieben (Stammdaten des Assets).
func handleImportAssetEBUCore(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cur, ok := assetOrgGuard(w, r, svc, r.PathValue("id"))
		if !ok {
			return
		}
		fields, err := svc.ListFields(cur.Type)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		imp, err := ebucore.Import(http.MaxBytesReader(w, r.Body, 4<<20), fields)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		merged := mergeMetadata(cur.Metadata, imp.Metadata)
		if problems := asset.ValidateMetadata(fields, merged); len(problems) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "metadata validation failed", "problems": problems, "imported": imp})
			return
		}
		if r.URL.Query().Get("dryRun") != "" {
			writeJSON(w, http.StatusOK, map[string]any{"dryRun": true, "imported": imp, "result": merged})
			return
		}
		expected := cur.RowVersion
		if v := r.URL.Query().Get("expectedRowVersion"); v != "" {
			n, perr := strconv.Atoi(v)
			if perr != nil {
				http.Error(w, "invalid expectedRowVersion", http.StatusBadRequest)
				return
			}
			expected = n
		}
		updatedBy := ""
		if p, ok := principalFromContext(r); ok {
			updatedBy = p.Username
		}
		a, err := svc.UpdateAssetMetadata(cur.ID, expected, merged, updatedBy)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"imported": imp, "asset": a})
	}
}

// mergeMetadata legt Importwerte über vorhandene Metadaten (je Schlüssel überschreibend).
func mergeMetadata(base, over asset.Metadata) asset.Metadata {
	m := func(a, b map[string]any) map[string]any {
		if a == nil && b == nil {
			return nil
		}
		out := map[string]any{}
		for k, v := range a {
			out[k] = v
		}
		for k, v := range b {
			out[k] = v
		}
		return out
	}
	return asset.Metadata{
		System: m(base.System, over.System), Technical: m(base.Technical, over.Technical),
		Descriptive: m(base.Descriptive, over.Descriptive), Editorial: m(base.Editorial, over.Editorial),
		Custom: m(base.Custom, over.Custom), AI: m(base.AI, over.AI),
	}
}

// ---- Feld-Registry (Kapitel 78.1) ---------------------------------------------------------------

// handleListAssetFields liefert GET /api/v1/asset-fields?assetType=: Standardfelder plus
// registrierte Felder, die für den Asset-Typ gelten (ohne Angabe: alle). Zusätzlich die
// Menge der Kategorien, Datentypen und EBUCore-Ziele, damit die UI sie nicht dupliziert.
func handleListAssetFields(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.ListFields(r.URL.Query().Get("assetType"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"fields":         list,
			"categories":     asset.MetadataCategories,
			"dataTypes":      []string{asset.FieldText, asset.FieldLongText, asset.FieldInteger, asset.FieldNumber, asset.FieldBoolean, asset.FieldDate, asset.FieldDateTime, asset.FieldEnum, asset.FieldURL},
			"ebucoreTargets": asset.EBUCoreTargets,
		})
	}
}

func handleCreateAssetField(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var f asset.Field
		if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		by := ""
		if p, ok := principalFromContext(r); ok {
			by = p.Username
		}
		out, err := svc.CreateField(f, by)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, by, "asset_field", out.ID, "created", map[string]any{"category": out.Category, "key": out.Key})
		writeJSON(w, http.StatusCreated, out)
	}
}

func handleUpdateAssetField(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var f asset.Field
		if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		out, err := svc.UpdateField(r.PathValue("id"), f)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		by := ""
		if p, ok := principalFromContext(r); ok {
			by = p.Username
		}
		logDomainAudit(domainAudit, by, "asset_field", out.ID, "updated", map[string]any{"category": out.Category, "key": out.Key})
		writeJSON(w, http.StatusOK, out)
	}
}

func handleDeleteAssetField(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if strings.HasPrefix(id, "builtin:") {
			http.Error(w, "built-in fields cannot be deleted", http.StatusBadRequest)
			return
		}
		if err := svc.DeleteField(id); err != nil {
			writeAssetError(w, err)
			return
		}
		by := ""
		if p, ok := principalFromContext(r); ok {
			by = p.Username
		}
		logDomainAudit(domainAudit, by, "asset_field", id, "deleted", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- AssetVersion ---------------------------------------------------------------------------------

// handleListAssetVersions liefert GET /api/v1/assets/{id}/versions.
func handleListAssetVersions(svc AssetService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, ok := assetOrgGuard(w, r, svc, id); !ok {
			return
		}
		list, err := svc.ListVersions(id)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// assetVersionOrgGuard (Kapitel 21 B14) — AssetVersion trägt selbst
// kein OwnerOrgID (s. Definition/Version-Doku in process_handlers.go
// für dieselbe "derive via parent"-Linie): Organisation ergibt sich
// über das referenzierte Asset.
func assetVersionOrgGuard(w http.ResponseWriter, r *http.Request, svc AssetService, id string) (asset.AssetVersion, bool) {
	v, err := svc.GetVersion(id)
	if err != nil {
		writeAssetError(w, err)
		return asset.AssetVersion{}, false
	}
	a, err := svc.GetAsset(v.AssetID)
	if err != nil {
		writeAssetError(w, err)
		return asset.AssetVersion{}, false
	}
	if !orgMatches(r, a.OwnerOrgID) {
		writeOrgNotFound(w)
		return asset.AssetVersion{}, false
	}
	return v, true
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
		id := r.PathValue("id")
		if _, ok := assetOrgGuard(w, r, svc, id); !ok {
			return
		}
		createdBy := ""
		if p, ok := principalFromContext(r); ok {
			createdBy = p.Username
		}
		v, err := svc.CreateVersion(id, body.ParentVersionID, body.ChangeReason, createdBy)
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
		v, ok := assetVersionOrgGuard(w, r, svc, r.PathValue("id"))
		if !ok {
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
		if _, ok := assetVersionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		if _, ok := assetVersionOrgGuard(w, r, svc, r.PathValue("id")); !ok {
			return
		}
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
		id := r.PathValue("id")
		if _, ok := assetVersionOrgGuard(w, r, svc, id); !ok {
			return
		}
		list, err := svc.ListRepresentations(id)
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
		if _, ok := assetVersionOrgGuard(w, r, svc, rep.AssetVersionID); !ok {
			return
		}
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
		if _, ok := assetVersionOrgGuard(w, r, svc, rep.AssetVersionID); !ok {
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
		id := r.PathValue("id")
		// Org-Check nur, wenn die Representation noch existiert — DELETE
		// bleibt idempotent (s. Store.DeleteRepresentation-Doku): ein
		// zweiter Aufruf auf eine bereits verschwundene ID darf nicht durch
		// den neuen Org-Guard zu einem 404 werden, wo vorher ein stilles
		// "ok" stand.
		if rep, err := svc.GetRepresentation(id); err == nil {
			if _, ok := assetVersionOrgGuard(w, r, svc, rep.AssetVersionID); !ok {
				return
			}
		} else if !errors.Is(err, asset.ErrNotFound) {
			writeAssetError(w, err)
			return
		}
		if err := svc.DeleteRepresentation(id); err != nil {
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
		c, err := svc.CreateCollection(body.Title, body.Description, createdBy, callerOrgID(r))
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
		// Kapitel 21 B14: nur die eigene Organisation, s. org_enforcement.go.
		visible := make([]asset.Collection, 0, len(list))
		for _, c := range list {
			if orgMatches(r, c.OwnerOrgID) {
				visible = append(visible, c)
			}
		}
		writeJSON(w, http.StatusOK, visible)
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
		if !orgMatches(r, c.OwnerOrgID) {
			writeOrgNotFound(w)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}

// collectionOrgGuard liest die Collection und lehnt mit 404 ab, wenn sie
// einer fremden Organisation gehört (Kapitel 21 B14).
func collectionOrgGuard(w http.ResponseWriter, r *http.Request, svc AssetService, id string) (asset.Collection, bool) {
	c, err := svc.GetCollection(id)
	if err != nil {
		writeAssetError(w, err)
		return asset.Collection{}, false
	}
	if !orgMatches(r, c.OwnerOrgID) {
		writeOrgNotFound(w)
		return asset.Collection{}, false
	}
	return c, true
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
		id := r.PathValue("id")
		if _, ok := collectionOrgGuard(w, r, svc, id); !ok {
			return
		}
		c, err := svc.UpdateCollectionMeta(id, body.Title, body.Description)
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
		// Org-Check nur, wenn die Collection noch existiert — DELETE bleibt
		// idempotent (s. Store.DeleteCollection-Doku), s. gleiches Muster
		// bei handleDeleteRepresentation.
		if c, err := svc.GetCollection(id); err == nil {
			if !orgMatches(r, c.OwnerOrgID) {
				writeOrgNotFound(w)
				return
			}
		} else if !errors.Is(err, asset.ErrNotFound) {
			writeAssetError(w, err)
			return
		}
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
		id := r.PathValue("id")
		if _, ok := collectionOrgGuard(w, r, svc, id); !ok {
			return
		}
		members, err := svc.ListCollectionMembers(id)
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
		if _, ok := collectionOrgGuard(w, r, svc, collectionID); !ok {
			return
		}
		if _, ok := assetOrgGuard(w, r, svc, body.AssetID); !ok {
			return
		}
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
		// Org-Check nur, wenn die Collection noch existiert — bleibt
		// idempotent wie zuvor (s. Store.RemoveCollectionMember-Doku),
		// gleiches Muster wie handleDeleteRepresentation.
		if c, err := svc.GetCollection(collectionID); err == nil {
			if !orgMatches(r, c.OwnerOrgID) {
				writeOrgNotFound(w)
				return
			}
		} else if !errors.Is(err, asset.ErrNotFound) {
			writeAssetError(w, err)
			return
		}
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
		if _, ok := assetOrgGuard(w, r, svc, body.FromAssetID); !ok {
			return
		}
		if _, ok := assetOrgGuard(w, r, svc, body.ToAssetID); !ok {
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
		id := r.PathValue("id")
		if _, ok := assetOrgGuard(w, r, svc, id); !ok {
			return
		}
		list, err := svc.ListRelationships(id)
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

// handlePurgeDeletedAssets liefert POST /api/v1/assets/purge-deleted {"olderThanDays": N} (N optional, 0 = alle): entfernt als
// gelöscht markierte Assets endgültig samt Versionen, Darstellungen und den Daten der Module (Eingang: Proxys, QC, Verlauf).
// Nicht rückgängig zu machen — nur Administratoren. Die Quelldateien selbst bleiben unberührt.
func handlePurgeDeletedAssets(svc AssetService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			OlderThanDays int `json:"olderThanDays"`
		}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		if body.OlderThanDays < 0 || body.OlderThanDays > 3650 {
			http.Error(w, "olderThanDays must be between 0 and 3650", http.StatusBadRequest)
			return
		}
		ids, err := svc.PurgeDeleted(time.Duration(body.OlderThanDays) * 24 * time.Hour)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "asset", "", "purged", map[string]any{"count": len(ids), "olderThanDays": body.OlderThanDays})
		writeJSON(w, http.StatusOK, map[string]any{"purged": len(ids), "ids": ids})
	}
}

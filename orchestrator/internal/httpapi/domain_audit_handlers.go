package httpapi

import (
	"net/http"
	"strconv"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/domainaudit"
)

// DomainAuditLogger protokolliert eine fachliche Aktion auf einem
// Domänen-Objekt (implementiert von *domainaudit.Store, Kapitel 21 B13).
// Best-effort wie AuditLogger — ein Fehlschlag darf die bereits
// ausgeführte Aktion selbst nicht rückwirkend scheitern lassen, daher
// kein Rückgabewert.
type DomainAuditLogger interface {
	Log(actor, objectType, objectID, action string, details map[string]any)
}

// DomainAuditReader liest Domain-Audit-Einträge (implementiert von
// *domainaudit.Store).
type DomainAuditReader interface {
	List(before int64, limit int) ([]domainaudit.Entry, error)
	ListByObject(objectType, objectID string, limit int) ([]domainaudit.Entry, error)
}

// logDomainAudit ruft logger.Log auf, falls logger nicht nil ist (Option
// WithDomainAudit fehlt in vielen Tests) — spart den Nil-Check an jeder
// einzelnen Aufrufstelle in process_handlers.go/asset_handlers.go.
func logDomainAudit(logger DomainAuditLogger, actor, objectType, objectID, action string, details map[string]any) {
	if logger == nil {
		return
	}
	logger.Log(actor, objectType, objectID, action, details)
}

// actorFromRequest liefert den Nutzernamen des authentifizierten
// Aufrufers für Domain-Audit-Einträge, "" im Bootstrap-Modus (noch kein
// Nutzer angelegt) — s. principalFromContext-Doku.
func actorFromRequest(r *http.Request) string {
	p, ok := principalFromContext(r)
	if !ok {
		return ""
	}
	return p.Username
}

// handleListDomainAuditLog ist GET /api/v1/domain-audit-log?before=<id>&
// limit=&objectType=&objectId= — admin-only (gleicher Schutz wie das
// bestehende /api/v1/admin/audit-log). objectType+objectId zusammen
// filtern auf die Historie EINES Objekts (Store.ListByObject, z. B. für
// ein "Historie"-Panel an einer Asset-/Prozess-Detailansicht); ohne
// beide liefert es die globale, neueste-zuerst-Liste wie das HTTP-Audit.
func handleListDomainAuditLog(reader DomainAuditReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := defaultAuditLogLimit
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > maxAuditLogLimit {
			limit = maxAuditLogLimit
		}

		objectType := r.URL.Query().Get("objectType")
		objectID := r.URL.Query().Get("objectId")
		if objectType != "" && objectID != "" {
			entries, err := reader.ListByObject(objectType, objectID, limit)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, entries)
			return
		}

		var before int64
		if v := r.URL.Query().Get("before"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 {
				before = parsed
			}
		}
		entries, err := reader.List(before, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}

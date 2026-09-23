package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/organizations"

	"github.com/jackc/pgx/v5/pgconn"
)

// ---- Organization (Kapitel 21 B14) ---------------------------------------------------------------
//
// Bewusst global-gescopt (VerbAdmin, s. server.go Routen), nicht per
// orgMatches gefiltert wie Workflow/ProcessDefinition/Asset/Collection:
// eine Organisation ANLEGEN/LÖSCHEN/AUFLISTEN ist per Definition eine
// organisationsübergreifende Handlung (UMSETZUNG.md §21.6) — es gibt
// keine "eigene Organisation", innerhalb derer ein Aufrufer weitere
// Organisationen verwalten dürfte.

// handleListOrganizations liefert GET /api/v1/organizations.
func handleListOrganizations(svc OrganizationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List()
		if err != nil {
			writeOrganizationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateOrganization liefert POST /api/v1/organizations:
// {"name": "..."}.
func handleCreateOrganization(svc OrganizationService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		o, err := svc.Create(body.Name)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "organization", o.ID, "created", map[string]any{"name": o.Name})
		writeJSON(w, http.StatusOK, o)
	}
}

// handleGetOrganization liefert GET /api/v1/organizations/{id}.
func handleGetOrganization(svc OrganizationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		o, err := svc.Get(r.PathValue("id"))
		if err != nil {
			writeOrganizationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, o)
	}
}

// handleDeleteOrganization liefert DELETE /api/v1/organizations/{id} —
// lehnt die Default-Organisation ab (ErrDefaultOrgImmutable, 409) und
// liefert einen echten Fremdschlüssel-Fehler (409), solange noch
// Nutzer/Fachobjekte auf sie verweisen (s. organizations.Store.Delete-
// Doku: bewusst keine Kaskade).
func handleDeleteOrganization(svc OrganizationService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.Delete(id); err != nil {
			writeOrganizationError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "organization", id, "deleted", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeOrganizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, organizations.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, organizations.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, organizations.ErrDefaultOrgImmutable):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			// Fremdschlüssel-Verstoß (Delete einer Organisation mit noch
			// existierenden Mitgliedern/Fachobjekten, s.
			// organizations.Store.Delete-Doku: bewusst keine Kaskade) —
			// 409 statt 500, derselbe Fehlercode wie ErrDefaultOrgImmutable.
			http.Error(w, "organization still has members or owned objects", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

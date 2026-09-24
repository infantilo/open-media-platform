package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/storagebackends"

	"github.com/jackc/pgx/v5/pgconn"
)

// ---- Storage-Backends (Nutzerauftrag 2026-09-24) --------------------------------------------------
//
// Bewusst global gescopt (VerbAdmin, s. server.go-Routen) — "only super
// admins may config this": wo Asset-Dateien tatsächlich liegen ist eine
// Infrastruktur-Entscheidung mit Sicherheits-/Kosten-Tragweite, kein
// gewöhnliches "configure"-Recht. Gleiches Muster wie die Organisations-
// Verwaltung (Nachtrag 283).

type storageBackendRequest struct {
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	AccessKey string `json:"accessKey"`
	// SecretKey: bei Create Pflicht, bei Update leer = unverändert
	// lassen (s. storagebackends.Store.UpdateMeta-Doku) — nie im
	// Response-Body zurückgegeben, s. storagebackends.Backend.HasSecret.
	SecretKey string `json:"secretKey"`
	UseSSL    bool   `json:"useSsl"`
}

func (req storageBackendRequest) toInput() storagebackends.Input {
	return storagebackends.Input{
		Name: req.Name, Provider: req.Provider, Endpoint: req.Endpoint, Bucket: req.Bucket,
		AccessKey: req.AccessKey, SecretKey: req.SecretKey, UseSSL: req.UseSSL,
	}
}

// handleListStorageBackends liefert GET /api/v1/storage-backends — die
// "full overview" aus dem Nutzerauftrag: immer die vollständige Liste,
// keine Pagination/Filterung nötig bei der erwarteten Größenordnung
// (Handvoll Backends, kein Katalog).
func handleListStorageBackends(svc StorageBackendService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List()
		if err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleGetStorageBackend liefert GET /api/v1/storage-backends/{id}.
func handleGetStorageBackend(svc StorageBackendService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := svc.Get(r.PathValue("id"))
		if err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, b)
	}
}

// handleTestStorageBackendConnection liefert POST
// /api/v1/storage-backends/test — der Wizard-"Verbindung testen"-
// Schritt (Nutzerauftrag: "protection guards... wizards"): prüft
// Erreichbarkeit/Zugangsdaten, OHNE zu persistieren. Nimmt dieselbe
// Eingabeform wie Create/Update.
func handleTestStorageBackendConnection(svc StorageBackendService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req storageBackendRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := svc.TestConnection(r.Context(), req.toInput()); err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleCreateStorageBackend liefert POST /api/v1/storage-backends —
// verbindet dabei selbst noch einmal (s. Store.Create-Doku: derselbe
// Schutz wie /test, falls der Wizard-Schritt übersprungen wurde oder
// sich die Lage zwischenzeitlich geändert hat), ein nicht erreichbares
// Backend wird NIE persistiert.
func handleCreateStorageBackend(svc StorageBackendService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req storageBackendRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := actorFromRequest(r)
		b, err := svc.Create(r.Context(), req.toInput(), createdBy)
		if err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "storage_backend", b.ID, "created", map[string]any{"name": b.Name, "endpoint": b.Endpoint, "bucket": b.Bucket})
		writeJSON(w, http.StatusOK, b)
	}
}

// handleUpdateStorageBackend liefert PUT /api/v1/storage-backends/{id}.
func handleUpdateStorageBackend(svc StorageBackendService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req storageBackendRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		b, err := svc.UpdateMeta(r.Context(), id, req.toInput())
		if err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_backend", b.ID, "updated", map[string]any{"name": b.Name})
		writeJSON(w, http.StatusOK, b)
	}
}

// handleStorageBackendLifecycle liefert POST
// /api/v1/storage-backends/{id}/deprecate bzw. .../reactivate — der
// abgestufte Zwischenschritt vor einem harten Löschen (s.
// storagebackends.Store.UpdateStatus-Doku): ein deprecated Backend
// liefert bestehende Dateien weiter aus, nimmt aber keine neuen
// Uploads mehr an.
func handleStorageBackendLifecycle(svc StorageBackendService, domainAudit DomainAuditLogger, toStatus string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := svc.UpdateStatus(r.PathValue("id"), toStatus)
		if err != nil {
			writeStorageBackendMgmtError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_backend", b.ID, toStatus, nil)
		writeJSON(w, http.StatusOK, b)
	}
}

// handleDeleteStorageBackend liefert DELETE /api/v1/storage-backends/{id}
// — prüft VOR dem Löschversuch, wie viele Representations noch
// verweisen, für eine konkrete Fehlermeldung ("wird noch von 3 Dateien
// verwendet") statt nur eines generischen Fremdschlüssel-Fehlers
// (Nutzerauftrag: "protection guards... with warnings"). Der
// Fremdschlüssel selbst (s. Migration) bleibt die verlässliche letzte
// Instanz gegen eine Race-Bedingung zwischen Zählen und Löschen.
func handleDeleteStorageBackend(svc StorageBackendService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if n, err := svc.CountRepresentations(id); err == nil && n > 0 {
			http.Error(w, storageBackendInUseMessage(n), http.StatusConflict)
			return
		}
		if err := svc.Delete(id); err != nil {
			if isForeignKeyViolation(err) {
				// Race: zwischen der Zählung oben und diesem Löschversuch
				// wurde eine neue Representation angelegt — derselbe Fall,
				// nur ohne den vorab bekannten Zähler.
				http.Error(w, storageBackendInUseMessage(0), http.StatusConflict)
				return
			}
			writeStorageBackendMgmtError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_backend", id, "deleted", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func storageBackendInUseMessage(n int) string {
	if n <= 0 {
		return "this storage backend is still referenced by at least one file — move or delete those first"
	}
	if n == 1 {
		return "this storage backend is still used by 1 file — move or delete it first"
	}
	return "this storage backend is still used by " + strconv.Itoa(n) + " files — move or delete them first"
}

// isForeignKeyViolation erkennt Postgres-Fehlercode 23503 — dieselbe
// Prüfung wie organization_handlers.go/auth_handlers.go, hier als
// eigener Helfer, weil er in dieser Datei ein drittes Mal gebraucht
// wird (CountRepresentations-Race-Fall UND der generische Fallback in
// writeStorageBackendMgmtError).
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func writeStorageBackendMgmtError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storagebackends.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, storagebackends.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, storagebackends.ErrUnreachable):
		http.Error(w, err.Error(), http.StatusBadGateway)
	default:
		if isForeignKeyViolation(err) {
			http.Error(w, storageBackendInUseMessage(0), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

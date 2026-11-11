package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/directory"
)

// DirectoryAdmin verwaltet die Einstellungen der Verzeichnis-Anbindung (implementiert von *directory.Manager).
type DirectoryAdmin interface {
	Settings(ctx context.Context) (directory.Settings, error)
	Save(ctx context.Context, s directory.Settings) error
	Test(ctx context.Context, s *directory.Settings) error
	Enabled() bool
	LastError() string
}

// DirectoryMapService verwaltet die Zuordnung Verzeichnisgruppe → OMP-Gruppe (implementiert von *directory.MapStore).
type DirectoryMapService interface {
	List(ctx context.Context) ([]directory.Mapping, error)
	Add(ctx context.Context, ldapGroup, groupID string) error
	Remove(ctx context.Context, ldapGroup, groupID string) error
}

// WithDirectory aktiviert die Verwaltung der Active-Directory-Anbindung (/api/v1/auth/directory…).
func WithDirectory(admin DirectoryAdmin, maps DirectoryMapService) HandlerOption {
	return func(o *handlerOptions) {
		o.dirAdmin = admin
		o.dirMaps = maps
	}
}

// handleDirectoryStatus: GET /api/v1/auth/directory — wirksam?, letzter Ladefehler, Einstellungen (ohne Kennwort).
func handleDirectoryStatus(admin DirectoryAdmin) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		set, err := admin.Settings(r.Context())
		out := map[string]any{"enabled": admin.Enabled(), "settings": set, "error": admin.LastError()}
		if err != nil && out["error"] == "" {
			out["error"] = err.Error()
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleDirectorySave: PUT /api/v1/auth/directory — speichert und wendet sofort an (kein Neustart).
func handleDirectorySave(admin DirectoryAdmin, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body directory.Settings
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := admin.Save(r.Context(), body); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, directory.ErrNoSecretKey) {
				status = http.StatusConflict
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "directory-config", "1", "updated", map[string]any{"enabled": body.Enabled, "urls": body.URLs, "baseDn": body.BaseDN})
		handleDirectoryStatus(admin)(w, r)
	}
}

// handleDirectoryTest ist POST /api/v1/auth/directory/test: bindet das Dienstkonto, ohne Nutzer anzulegen. Mit Body
// werden die (noch nicht gespeicherten) Formularwerte geprüft.
func handleDirectoryTest(admin DirectoryAdmin) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var set *directory.Settings
		if r.ContentLength != 0 {
			var body directory.Settings
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err == nil {
				set = &body
			}
		}
		if err := admin.Test(r.Context(), set); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleDirectoryMappings(maps DirectoryMapService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := maps.List(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleDirectoryAddMapping(maps DirectoryMapService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body directory.Mapping
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := maps.Add(r.Context(), body.LDAPGroup, body.GroupID); err != nil {
			if errors.Is(err, directory.ErrMappingInvalid) {
				http.Error(w, "ldapGroup and an existing groupId required", http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "directory-mapping", body.GroupID, "created", map[string]any{"ldapGroup": body.LDAPGroup})
		writeJSON(w, http.StatusOK, body)
	}
}

func handleDirectoryRemoveMapping(maps DirectoryMapService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body directory.Mapping
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := maps.Remove(r.Context(), body.LDAPGroup, body.GroupID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "directory-mapping", body.GroupID, "deleted", map[string]any{"ldapGroup": body.LDAPGroup})
		w.WriteHeader(http.StatusNoContent)
	}
}

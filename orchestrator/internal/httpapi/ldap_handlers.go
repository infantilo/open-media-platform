package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/directory"
)

// DirectoryPinger prüft die Verbindung zum Verzeichnis (implementiert von *directory.Client).
type DirectoryPinger interface {
	Ping(ctx context.Context) error
}

// DirectoryMapService verwaltet die Zuordnung Verzeichnisgruppe → OMP-Gruppe (implementiert von *directory.MapStore).
type DirectoryMapService interface {
	List(ctx context.Context) ([]directory.Mapping, error)
	Add(ctx context.Context, ldapGroup, groupID string) error
	Remove(ctx context.Context, ldapGroup, groupID string) error
}

// WithDirectory aktiviert die Verwaltung der Active-Directory-Anbindung (/api/v1/auth/directory…). pinger darf nil
// sein (Anbindung nicht konfiguriert): Status meldet dann enabled=false, Zuordnungen bleiben pflegbar.
func WithDirectory(pinger DirectoryPinger, maps DirectoryMapService) HandlerOption {
	return func(o *handlerOptions) {
		if pinger != nil {
			o.dirPinger = pinger
		}
		o.dirMaps = maps
	}
}

func handleDirectoryStatus(pinger DirectoryPinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": pinger != nil})
	}
}

// handleDirectoryTest ist POST /api/v1/auth/directory/test: bindet das Dienstkonto, ohne Nutzer anzulegen.
func handleDirectoryTest(pinger DirectoryPinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if pinger == nil {
			http.Error(w, "directory not configured (OMP_LDAP_URL)", http.StatusConflict)
			return
		}
		if err := pinger.Ping(r.Context()); err != nil {
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

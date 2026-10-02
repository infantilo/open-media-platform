package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/locations"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

// Lokale Speicherorte (Kapitel 29 Nachtrag B). Alle Routen VerbAdmin, Änderungen im Domänen-Audit.

// LocationStore ist der Speicher der Orte (*locations.Store).
type LocationStore interface {
	List() ([]locations.Location, error)
	Get(id string) (locations.Location, error)
	Create(in locations.Input, by string) (locations.Location, error)
	Update(id, name, note, status string) (locations.Location, error)
	Delete(id string) error
}

// WithLocations aktiviert /api/v1/admin/storage-locations*.
func WithLocations(s LocationStore) HandlerOption {
	return func(o *handlerOptions) { o.locations = s }
}

type locationUse struct {
	NodeType string `json:"nodeType"`
	Option   string `json:"option"`
	Value    string `json:"value"`
	// Instance gesetzt = Wert nur für diese Instanz, sonst Typ-Wert (gilt für alle Hosts).
	InstanceID    string `json:"instanceId,omitempty"`
	InstanceLabel string `json:"instanceLabel,omitempty"`
}

type locationView struct {
	locations.Location
	Check      *nodeoptions.PathInfo `json:"check,omitempty"`
	CheckError string                `json:"checkError,omitempty"`
	Usage      []locationUse         `json:"usage"`
}

// checkLocation prüft den Pfad lokal oder über den Host-Agent.
func checkLocation(svc LauncherService, l locations.Location) (*nodeoptions.PathInfo, string) {
	if l.HostID == "" {
		info := nodeoptions.CheckPath(l.Path, nodeoptions.PathDir)
		return &info, ""
	}
	chk, ok := svc.(hostPathChecker)
	if !ok {
		return nil, "Remote-Prüfung nicht verfügbar"
	}
	info, err := chk.CheckPathOnHost(l.HostID, l.Path, nodeoptions.PathDir)
	if err != nil {
		return nil, "Host nicht erreichbar: " + err.Error()
	}
	return &info, ""
}

// locationUsage sucht Node-Einstellungen (Pfad-Optionen), die in den Ort zeigen.
func locationUsage(l locations.Location, values NodeOptionValues, svc LauncherService) []locationUse {
	out := []locationUse{}
	src, ok := svc.(nodeOptionSource)
	if values == nil || !ok {
		return out
	}
	all, _ := values.AllInstanceValues()
	instances := svc.List()
	for _, c := range svc.Catalog() {
		schema := src.NodeOptions(c.Type)
		typeVals, _ := values.Values(nodeoptions.ScopeType, c.Type)
		for _, o := range schema {
			if o.Type != nodeoptions.TypePath {
				continue
			}
			if v := typeVals[o.Key]; locations.Within(l.Path, v) {
				out = append(out, locationUse{NodeType: c.Type, Option: o.Key, Value: v})
			}
			for _, in := range instances {
				if in.Type != c.Type || in.HostID != l.HostID {
					continue
				}
				if v := all[in.ID][o.Key]; locations.Within(l.Path, v) {
					out = append(out, locationUse{NodeType: c.Type, Option: o.Key, Value: v, InstanceID: in.ID, InstanceLabel: in.Label})
				}
			}
		}
	}
	return out
}

// handleListLocations: GET /api/v1/admin/storage-locations.
func handleListLocations(store LocationStore, values NodeOptionValues, svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Speicherorte nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		list, err := store.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]locationView, len(list))
		var wg sync.WaitGroup
		for i := range list {
			out[i] = locationView{Location: list[i], Usage: locationUsage(list[i], values, svc)}
			wg.Add(1)
			if r.URL.Query().Get("checks") == "0" { // nur Namen/Pfade (Auswahllisten), keine Host-Anfragen
				wg.Done()
				continue
			}
			go func(i int) { // Host-Agent-Prüfungen parallel (jede hat ein eigenes Timeout)
				defer wg.Done()
				out[i].Check, out[i].CheckError = checkLocation(svc, list[i])
			}(i)
		}
		wg.Wait()
		writeJSON(w, http.StatusOK, map[string]any{"locations": out})
	}
}

// handleCreateLocation: POST /api/v1/admin/storage-locations {"name","hostId","path","note","force"}.
func handleCreateLocation(store LocationStore, svc LauncherService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Speicherorte nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		var body struct {
			Name   string `json:"name"`
			HostID string `json:"hostId"`
			Path   string `json:"path"`
			Note   string `json:"note"`
			Force  bool   `json:"force"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		in := locations.Input{Name: body.Name, HostID: body.HostID, Path: body.Path, Note: body.Note}
		if err := in.Validate(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		probe := locations.Location{HostID: in.HostID, Path: in.Path}
		info, cerr := checkLocation(svc, probe)
		warning := ""
		switch {
		case cerr != "":
			if !body.Force {
				http.Error(w, "Prüfung nicht möglich: "+cerr+" (zum Anlegen trotzdem force setzen)", http.StatusBadGateway)
				return
			}
			warning = cerr
		case !info.Readable || !info.IsDir:
			if !body.Force {
				http.Error(w, "Pfad nicht nutzbar: "+info.Message+" (zum Anlegen trotzdem force setzen)", http.StatusBadRequest)
				return
			}
			warning = info.Message
		}
		l, err := store.Create(in, actorFromRequest(r))
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, locations.ErrDuplicate) {
				status = http.StatusConflict
			} else if errors.Is(err, locations.ErrValidation) {
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_location", l.ID, "created",
			map[string]any{"name": l.Name, "hostId": l.HostID, "path": l.Path})
		writeJSON(w, http.StatusCreated, map[string]any{"location": l, "warning": warning})
	}
}

// handleUpdateLocation: PUT /api/v1/admin/storage-locations/{id} {"name","note","status"}.
func handleUpdateLocation(store LocationStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Speicherorte nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		var body struct {
			Name   string `json:"name"`
			Note   string `json:"note"`
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		l, err := store.Update(r.PathValue("id"), body.Name, body.Note, body.Status)
		if err != nil {
			status := http.StatusInternalServerError
			switch {
			case errors.Is(err, locations.ErrNotFound):
				status = http.StatusNotFound
			case errors.Is(err, locations.ErrDuplicate):
				status = http.StatusConflict
			case errors.Is(err, locations.ErrValidation):
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_location", l.ID, "updated", map[string]any{"name": l.Name, "status": l.Status})
		writeJSON(w, http.StatusOK, l)
	}
}

// handleDeleteLocation: DELETE /api/v1/admin/storage-locations/{id} — verweigert, solange
// Node-Einstellungen in den Ort zeigen (Schutz vor Löschen unter laufenden Nodes).
func handleDeleteLocation(store LocationStore, values NodeOptionValues, svc LauncherService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Speicherorte nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		l, err := store.Get(r.PathValue("id"))
		if err != nil {
			if errors.Is(err, locations.ErrNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if use := locationUsage(l, values, svc); len(use) > 0 {
			http.Error(w, fmt.Sprintf("Speicherort wird noch von %d Node-Einstellung(en) verwendet (z. B. %s → %s) — dort zuerst ändern", len(use), use[0].NodeType, use[0].Option), http.StatusConflict)
			return
		}
		if err := store.Delete(l.ID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "storage_location", l.ID, "deleted", map[string]any{"name": l.Name})
		w.WriteHeader(http.StatusNoContent)
	}
}

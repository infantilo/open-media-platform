package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeversions"
)

// Node-Versionierung (Kapitel 28): Versionsspeicher je Node-Typ, produktive
// Version pro Typ, Auf-/Abwärtswechsel ohne Gesamt-Update. Alle Routen
// VerbAdmin — ein Binary auszutauschen ist ausführbarer Code.

// NodeVersionStore ist der Versionsspeicher (implementiert von *nodeversions.Store).
type NodeVersionStore interface {
	Names() []string
	List(name string) []nodeversions.Version
	Productive(name string) string
	SetProductive(name, id string) error
	Delete(name, id string) error
	RegisterInstalled(paths map[string]string) ([]nodeversions.Version, map[string]string)
}

// WithNodeVersions aktiviert /api/v1/admin/node-versions*.
func WithNodeVersions(s NodeVersionStore) HandlerOption {
	return func(o *handlerOptions) { o.nodeVersions = s }
}

// catalogBinaries: Binary-Name → (Katalog-Typen, Pfad) der lokalen Prozess-Einträge.
func catalogBinaries(cat []launcher.CatalogEntry) (map[string]string, map[string][]string) {
	paths := map[string]string{}
	types := map[string][]string{}
	for _, c := range cat {
		if c.Runner != "process" && c.Runner != "" || len(c.Command) == 0 {
			continue
		}
		name := filepath.Base(c.Command[0])
		if _, ok := paths[name]; !ok {
			paths[name] = c.Command[0]
		}
		types[name] = append(types[name], c.Type)
	}
	return paths, types
}

type nodeVersionInstance struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Type        string `json:"type"`
	NodeVersion string `json:"nodeVersion,omitempty"`
	Outdated    bool   `json:"outdated"`
	Remote      bool   `json:"remote,omitempty"`
}

type nodeVersionType struct {
	Name       string                 `json:"name"`
	Types      []string               `json:"catalogTypes"`
	Installed  *nodeversions.Info     `json:"installed,omitempty"`
	Productive string                 `json:"productive"`
	Versions   []nodeversions.Version `json:"versions"`
	Instances  []nodeVersionInstance  `json:"instances"`
}

// handleListNodeVersions: GET /api/v1/admin/node-versions.
func handleListNodeVersions(store NodeVersionStore, svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Node-Versionierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		paths, types := catalogBinaries(svc.Catalog())
		names := map[string]bool{}
		for n := range paths {
			names[n] = true
		}
		for _, n := range store.Names() {
			names[n] = true
		}
		byType := map[string][]launcher.Instance{}
		for _, in := range instancesWithOutdated(svc) {
			byType[in.Type] = append(byType[in.Type], in)
		}
		out := make([]nodeVersionType, 0, len(names))
		for name := range names {
			t := nodeVersionType{Name: name, Types: types[name], Productive: store.Productive(name),
				Versions: store.List(name), Instances: []nodeVersionInstance{}}
			if t.Versions == nil {
				t.Versions = []nodeversions.Version{}
			}
			if p, ok := paths[name]; ok {
				if info, err := nodeversions.InstalledInfo(p); err == nil {
					t.Installed = &info
				}
			}
			for _, typ := range types[name] {
				for _, in := range byType[typ] {
					t.Instances = append(t.Instances, nodeVersionInstance{ID: in.ID, Label: in.Label, Type: in.Type,
						NodeVersion: in.NodeVersion, Outdated: in.Outdated, Remote: in.HostID != ""})
				}
			}
			out = append(out, t)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
		writeJSON(w, http.StatusOK, map[string]any{"types": out})
	}
}

// handleRescanNodeVersions: POST /api/v1/admin/node-versions/rescan — archiviert
// die installierten (gestempelten) Binaries.
func handleRescanNodeVersions(store NodeVersionStore, svc LauncherService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Node-Versionierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		paths, _ := catalogBinaries(svc.Catalog())
		added, skipped := store.RegisterInstalled(paths)
		logDomainAudit(domainAudit, actorFromRequest(r), "node_version", "*", "rescanned", map[string]any{"added": len(added)})
		writeJSON(w, http.StatusOK, map[string]any{"added": added, "skipped": skipped})
	}
}

// handleSetProductiveNodeVersion: PUT /api/v1/admin/node-versions/{name}/productive
// {"version":"<id>"} ("" = zurück zum installierten Binary).
func handleSetProductiveNodeVersion(store NodeVersionStore, svc LauncherService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Node-Versionierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		name := r.PathValue("name")
		var body struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		prev := store.Productive(name)
		if err := store.SetProductive(name, body.Version); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, nodeversions.ErrNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "node_version", name, "productive_set",
			map[string]any{"from": prev, "to": body.Version})
		slog.Info("node-versionen: produktive Version gesetzt", "node", name, "from", prev, "to", body.Version)
		// Wie viele laufende Instanzen starten beim nächsten Neustart anders?
		_, types := catalogBinaries(svc.Catalog())
		isType := map[string]bool{}
		for _, t := range types[name] {
			isType[t] = true
		}
		outdated := 0
		for _, in := range instancesWithOutdated(svc) {
			if isType[in.Type] && in.Outdated {
				outdated++
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"productive": body.Version,
			"note":       fmt.Sprintf("gilt für neu gestartete Instanzen; %d laufende Instanz(en) laufen noch mit einem anderen Stand (Admin → System-Update → „Veraltete neu starten“)", outdated),
			"outdated":   outdated,
		})
	}
}

// handleDeleteNodeVersion: DELETE /api/v1/admin/node-versions/{name}/{id}.
func handleDeleteNodeVersion(store NodeVersionStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Node-Versionierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		name, id := r.PathValue("name"), r.PathValue("id")
		if err := store.Delete(name, id); err != nil {
			status := http.StatusConflict
			if errors.Is(err, nodeversions.ErrNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "node_version", name, "deleted", map[string]any{"version": id})
		w.WriteHeader(http.StatusNoContent)
	}
}

// nodeRegistrar liefert den Versionsspeicher als Registrar (nil, wenn er fehlt
// oder nur die Listen-Schnittstelle erfüllt).
func (o *handlerOptions) nodeRegistrar() NodeVersionRegistrar {
	r, _ := o.nodeVersions.(NodeVersionRegistrar)
	return r
}

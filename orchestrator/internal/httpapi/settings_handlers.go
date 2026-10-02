package httpapi

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/runtimesettings"
)

// Einstellungen über die UI (Kapitel 29). Alle Routen VerbAdmin; jede Änderung
// wird im Domänen-Audit protokolliert.

// NodeOptionValues ist der Wertespeicher der Node-Optionen (*nodeoptions.Store).
type NodeOptionValues interface {
	Values(scope, subject string) (map[string]string, error)
	AllInstanceValues() (map[string]map[string]string, error)
	Set(scope, subject, key, value, by string) error
	// MoveInstance überträgt die Instanz-Werte auf eine neue Instanz-ID (Neustart).
	MoveInstance(from, to string) error
}

// SystemSettingsStore speichert Überschreibungen der Betriebswerte (*runtimesettings.Store).
type SystemSettingsStore interface {
	Overrides() (map[string]string, error)
	Set(key, value, by string) error
}

// hostPathChecker prüft Pfade auf dem Dateisystem eines Remote-Hosts (Launcher → Host-Agent).
type hostPathChecker interface {
	CheckPathOnHost(hostID, path, kind string) (nodeoptions.PathInfo, error)
}

// nodeOptionSource ist die Fähigkeit des Launchers, Schema und „Neustart nötig“ zu nennen.
type nodeOptionSource interface {
	NodeOptions(nodeType string) []nodeoptions.Option
	OptionsChanged(nodeType, instanceID string) bool
}

// WithSettings aktiviert /api/v1/admin/settings*. startupSkipped sind die beim Start
// verworfenen Überschreibungen (Anzeige).
func WithSettings(nodeValues NodeOptionValues, system SystemSettingsStore, startupSkipped []string) HandlerOption {
	return func(o *handlerOptions) {
		o.nodeValues, o.systemSettings, o.startupSkipped = nodeValues, system, startupSkipped
	}
}

type optionView struct {
	nodeoptions.Option
	// Value ist der für den Node-TYP gespeicherte Wert ("" = Standard).
	Value string `json:"value,omitempty"`
}

type settingsInstance struct {
	ID            string            `json:"id"`
	Label         string            `json:"label"`
	Remote        bool              `json:"remote,omitempty"`
	Overrides     map[string]string `json:"overrides"`
	RestartNeeded bool              `json:"restartNeeded"`
}

type settingsNodeType struct {
	Type      string             `json:"type"`
	Label     string             `json:"label"`
	Options   []optionView       `json:"options"`
	Instances []settingsInstance `json:"instances"`
}

// handleListNodeSettings: GET /api/v1/admin/settings/nodes.
func handleListNodeSettings(values NodeOptionValues, svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		src, ok := svc.(nodeOptionSource)
		if values == nil || !ok {
			http.Error(w, "Einstellungen nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		all, err := values.AllInstanceValues()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		instances := svc.List()
		out := []settingsNodeType{}
		for _, c := range svc.Catalog() {
			schema := src.NodeOptions(c.Type)
			if len(schema) == 0 {
				continue
			}
			typeVals, err := values.Values(nodeoptions.ScopeType, c.Type)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			t := settingsNodeType{Type: c.Type, Label: c.Label, Options: make([]optionView, 0, len(schema)), Instances: []settingsInstance{}}
			for _, o := range schema {
				t.Options = append(t.Options, optionView{Option: o, Value: typeVals[o.Key]})
			}
			for _, in := range instances {
				if in.Type != c.Type {
					continue
				}
				ov := map[string]string{}
				for k, v := range all[in.ID] {
					if _, declared := nodeoptions.Find(schema, k); declared {
						ov[k] = v
					}
				}
				t.Instances = append(t.Instances, settingsInstance{ID: in.ID, Label: in.Label, Remote: in.HostID != "",
					Overrides: ov, RestartNeeded: src.OptionsChanged(c.Type, in.ID)})
			}
			sort.Slice(t.Instances, func(i, j int) bool { return t.Instances[i].Label < t.Instances[j].Label })
			out = append(out, t)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
		writeJSON(w, http.StatusOK, map[string]any{"types": out})
	}
}

// handleSetNodeSetting: PUT /api/v1/admin/settings/nodes/{type}/{key}
// {"value":"…","instanceId":"…"} — instanceId leer = für den ganzen Typ; value leer = Standard.
func handleSetNodeSetting(values NodeOptionValues, svc LauncherService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		src, ok := svc.(nodeOptionSource)
		if values == nil || !ok {
			http.Error(w, "Einstellungen nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		nodeType, key := r.PathValue("type"), r.PathValue("key")
		var body struct {
			Value      string `json:"value"`
			InstanceID string `json:"instanceId"`
			// Force speichert auch dann, wenn ein Pfad auf DIESEM Rechner (Orchestrator) nicht
			// existiert, aber z. B. nur auf einem Remote-Host vorhanden ist.
			Force bool `json:"force"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		opt, found := nodeoptions.Find(src.NodeOptions(nodeType), key)
		if !found {
			http.Error(w, "unbekannte Option für diesen Node-Typ", http.StatusNotFound)
			return
		}
		scope, subject := nodeoptions.ScopeType, nodeType
		checkFS := true
		remoteHost := ""
		if body.InstanceID != "" {
			inst, ok := svc.Get(body.InstanceID)
			if !ok || inst.Type != nodeType {
				http.Error(w, "Instanz nicht gefunden (oder anderer Node-Typ)", http.StatusNotFound)
				return
			}
			if inst.HostID != "" {
				// Remote-Instanz: Pfade gelten auf DEM Host — der Host-Agent prüft sie beim Start
				// gegen sein eigenes Dateisystem und sein eigenes Schema.
				checkFS, remoteHost = false, inst.HostID
			}
			scope, subject = nodeoptions.ScopeInstance, body.InstanceID
		}
		value, warning, err := nodeoptions.ValidateWith(opt, body.Value, checkFS)
		if err != nil && body.Force && opt.Type == nodeoptions.TypePath {
			if v2, _, err2 := nodeoptions.ValidateWith(opt, body.Value, false); err2 == nil {
				value, warning, err = v2, "auf diesem Rechner nicht geprüft/vorhanden (erzwungen) — gilt dort, wo der Pfad existiert", nil
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if remoteHost != "" && value != "" && opt.Type == nodeoptions.TypePath {
			if chk, ok := svc.(hostPathChecker); ok {
				if info, cerr := chk.CheckPathOnHost(remoteHost, value, opt.PathKind); cerr != nil {
					warning = "Pfad auf dem Remote-Host nicht prüfbar: " + cerr.Error()
				} else if !info.Readable {
					warning = "auf dem Remote-Host: " + info.Message + " — der Start dort schlägt fehl, bis der Pfad stimmt"
				}
			}
		}
		if err := values.Set(scope, subject, key, value, actorFromRequest(r)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "node_setting", nodeType+"/"+key, "set",
			map[string]any{"scope": scope, "subject": subject, "value": value})
		restart := 0
		for _, in := range svc.List() {
			if in.Type == nodeType && src.OptionsChanged(nodeType, in.ID) {
				restart++
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"value": value, "warning": warning, "restartNeeded": restart})
	}
}

// handleCheckPath: POST /api/v1/admin/settings/check-path {"path":"…","kind":"dir|file"}.
func handleCheckPath(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path   string `json:"path"`
			Kind   string `json:"kind"`
			HostID string `json:"hostId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
			http.Error(w, "path erforderlich", http.StatusBadRequest)
			return
		}
		if body.HostID != "" {
			chk, ok := svc.(hostPathChecker)
			if !ok {
				http.Error(w, "Remote-Prüfung nicht verfügbar", http.StatusNotImplemented)
				return
			}
			info, err := chk.CheckPathOnHost(body.HostID, body.Path, body.Kind)
			if err != nil {
				http.Error(w, "Host nicht erreichbar: "+err.Error(), http.StatusBadGateway)
				return
			}
			writeJSON(w, http.StatusOK, info)
			return
		}
		writeJSON(w, http.StatusOK, nodeoptions.CheckPath(body.Path, body.Kind))
	}
}

// handleListSystemSettings: GET /api/v1/admin/settings/system.
func handleListSystemSettings(store SystemSettingsStore, active config.Config, skipped []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Einstellungen nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		overrides, err := store.Overrides()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"items":   runtimesettings.Items(&active, overrides),
			"startup": runtimesettings.StartupInfo(active),
			"skipped": skipped,
		})
	}
}

// handleSetSystemSetting: PUT /api/v1/admin/settings/system/{key} {"value":"…"} ("" = Standard).
func handleSetSystemSetting(store SystemSettingsStore, active config.Config, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "Einstellungen nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		key := r.PathValue("key")
		def, ok := runtimesettings.Find(key)
		if !ok {
			http.Error(w, "unbekannte Einstellung", http.StatusNotFound)
			return
		}
		var body struct {
			Value string `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		value := ""
		if body.Value != "" {
			v, err := def.Parse(body.Value)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			value = trimNumber(v, def.Integer)
		}
		overrides, err := store.Overrides()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Widerspruchsprüfung mit allen Überschreibungen zusammen (gesund < überlastet).
		next := map[string]string{}
		for k, v := range overrides {
			next[k] = v
		}
		if value == "" {
			delete(next, key)
		} else {
			next[key] = value
		}
		probe := active
		if skipped := runtimesettings.Apply(&probe, next); len(skipped) > 0 {
			http.Error(w, "Widerspruch mit anderen Einstellungen: "+skipped[len(skipped)-1], http.StatusBadRequest)
			return
		}
		if err := store.Set(key, value, actorFromRequest(r)); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_setting", key, "set", map[string]any{"value": value})
		writeJSON(w, http.StatusOK, map[string]any{"value": value, "note": "wirksam nach dem nächsten Neustart des Orchestrators"})
	}
}

func trimNumber(v float64, integer bool) string {
	b, _ := json.Marshal(v)
	if integer {
		b, _ = json.Marshal(int64(v))
	}
	return string(b)
}

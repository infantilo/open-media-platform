package audiorules

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Audio-Regeln je Channel (Nutzerwunsch 2026-11-05: „Audio-Ausgabe gehört in die Automations-Konfiguration pro Channel“).
//
// Ein Channel kann ein EIGENES Dokument haben (Schlüssel `audio-rules:channel:<id>` im Einstellungsspeicher); fehlt es, gilt
// das plattformweite Dokument als Vorlage/Standard. Nodes holen weiter `GET /api/v1/audio-rules`: der Orchestrator wählt
// das Dokument nach dem Aufrufer — eine Instanz, die als Rolle in einem Workflow läuft, bekommt das Dokument des Channels
// dieses Workflows; sonst gilt `?channelId=` (Player-Umgebung `OMP_AUDIO_RULES_CHANNEL`) oder das plattformweite Dokument.

const channelKeyPrefix = "audio-rules:channel:"

var channelIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

type channelRules struct {
	settings module.NodeSettings
	db       *sql.DB
	roles    InstanceRoleResolver
	actor    func(*http.Request) string
	// labelOf liefert das Label einer Instanz (der Zielname, den die Automation für ihre Player/Mischer kennt).
	labelOf func(instanceID string) string

	mu sync.Mutex // schützt den Lese-Ändern-Schreiben-Zyklus des Zielindex
}

// Zielindex: Label eines Nodes → Channel, dessen Automation ihn als Ziel führt. Die Automation meldet ihre Ziele selbst
// (`POST …/targets`); ein Player, den keine Automation führt, bleibt dadurch standalone (Plattform-Standard).
const targetIndexKey = "audio-rules:targets"

func (c *channelRules) targetIndex() map[string]string {
	idx := map[string]string{}
	if data, err := c.settings.Get(targetIndexKey); err == nil {
		_ = json.Unmarshal(data, &idx)
	}
	if idx == nil {
		idx = map[string]string{}
	}
	return idx
}

// targetChannelID: der Channel, dessen Automation die Instanz (über ihr Label) als Ziel führt ("" = keiner).
func (c *channelRules) targetChannelID(instanceID string) string {
	if c.labelOf == nil || instanceID == "" {
		return ""
	}
	label := c.labelOf(instanceID)
	if label == "" {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.targetIndex()[label]
}

// callerBoundToChannel: der Aufrufer ist die an den Channel gebundene Instanz (direkt oder über die Workflow-Rolle).
func (c *channelRules) callerBoundToChannel(actor, channelID string) bool {
	if actor == "" {
		return true // Bootstrap-Modus ohne Nutzer, wie überall im Kern
	}
	if c.db == nil {
		return false
	}
	var inst, wf, role string
	if err := c.db.QueryRow(`SELECT instance_id, workflow_id, role FROM playout_channels WHERE id = $1`, channelID).Scan(&inst, &wf, &role); err != nil {
		return false
	}
	if inst != "" && inst == actor {
		return true
	}
	if wf != "" && c.roles != nil {
		if w, r, ok := c.roles.FindRoleForInstance(actor); ok {
			return w == wf && r == role
		}
	}
	return false
}

// handlePostTargets: die Automation eines Channels meldet die Labels ihrer Ziel-Nodes (Player A/B, Audiomischer).
func (c *channelRules) handlePostTargets() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !channelIDPattern.MatchString(id) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}
		actor := ""
		if c.actor != nil {
			actor = c.actor(r)
		}
		if !c.callerBoundToChannel(actor, id) {
			http.Error(w, "forbidden: nur die an den Channel gebundene Automation", http.StatusForbidden)
			return
		}
		var body struct {
			Labels []string `json:"labels"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		idx := c.targetIndex()
		for label, ch := range idx {
			if ch == id {
				delete(idx, label)
			}
		}
		n := 0
		for _, l := range body.Labels {
			if l = strings.TrimSpace(l); l != "" {
				idx[l] = id
				n++
			}
		}
		data, _ := json.Marshal(idx)
		if err := c.settings.Put(targetIndexKey, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"channelId": id, "targets": n})
	}
}

// channelDoc liefert das eigene Dokument eines Channels (nil = keines gesetzt; der Wert „null“ ist die Rücknahme).
func (c *channelRules) channelDoc(id string) ([]byte, error) {
	data, err := c.settings.Get(channelKeyPrefix + id)
	if errors.Is(err, module.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if t := strings.TrimSpace(string(data)); t == "" || t == "null" {
		return nil, nil
	}
	return data, nil
}

func (c *channelRules) platformDoc() ([]byte, error) {
	data, err := c.settings.Get(audioRulesKey)
	if errors.Is(err, module.ErrNotFound) {
		return defaultAudioRulesJSON, nil
	}
	return data, err
}

// workflowChannelID: der Channel, dessen Workflow die Instanz als Rolle enthält ("" = keiner).
func (c *channelRules) workflowChannelID(instanceID string) string {
	if c.roles == nil || c.db == nil || instanceID == "" {
		return ""
	}
	wf, _, ok := c.roles.FindRoleForInstance(instanceID)
	if !ok || wf == "" {
		return ""
	}
	var id string
	if err := c.db.QueryRow(`SELECT id FROM playout_channels WHERE workflow_id = $1 ORDER BY created_at LIMIT 1`, wf).Scan(&id); err != nil {
		return ""
	}
	return id
}

// handleGetEffective: das für den Aufrufer gültige Dokument (Kanal-Dokument oder Plattform-Standard).
func (c *channelRules) handleGetEffective() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.URL.Query().Get("channelId"))
		if id == "" {
			actor := ""
			if c.actor != nil {
				actor = c.actor(r)
			}
			id = c.workflowChannelID(actor)
			if id == "" {
				id = c.targetChannelID(actor)
			}
		}
		source := "platform"
		var data []byte
		if id != "" && channelIDPattern.MatchString(id) {
			d, err := c.channelDoc(id)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if d != nil {
				data, source = d, "channel"
			}
		}
		if data == nil {
			d, err := c.platformDoc()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			data = d
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Audio-Rules-Source", source)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// handleGetChannel: {"source":"channel"|"platform","rules":{…}} — für den Editor in der Automations-Konfiguration.
func (c *channelRules) handleGetChannel() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !channelIDPattern.MatchString(id) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}
		source := "channel"
		data, err := c.channelDoc(id)
		if err == nil && data == nil {
			source = "platform"
			data, err = c.platformDoc()
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"source": source, "rules": json.RawMessage(data)})
	}
}

func (c *channelRules) handlePutChannel() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !channelIDPattern.MatchString(id) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}
		var doc audioRulesDoc
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&doc); err != nil {
			http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if errs := validateAudioRules(doc); len(errs) > 0 {
			http.Error(w, strings.Join(errs, "\n"), http.StatusBadRequest)
			return
		}
		data, err := json.Marshal(doc)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := c.settings.Put(channelKeyPrefix+id, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, doc)
	}
}

// handleDeleteChannel nimmt das eigene Dokument zurück: der Channel erbt wieder den Plattform-Standard.
func (c *channelRules) handleDeleteChannel() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !channelIDPattern.MatchString(id) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}
		if err := c.settings.Put(channelKeyPrefix+id, []byte("null")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

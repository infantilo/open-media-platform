package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sourcetags"
)

// ---- Quellen mit semantischen Tags (Kapitel 27 / P4, E3) -------------------------------------------
//
// GET  /api/v1/sources                 — alle Sender als Quelle, Tags je Herkunft
// PUT  /api/v1/sources/{senderId}/tags — EXPLICIT-Tags ersetzen (global `configure`)
//
// Eine einzige, gemeinsame Sicht für Playlist-Editor, Source-Resolver und
// Audio-Routing (Spec §254/§255: keine fünf Source-Modelle).

// SourceTagStore wird von *sourcetags.Store implementiert.
type SourceTagStore interface {
	All() (map[sourcetags.Key][]string, error)
	Set(k sourcetags.Key, tags []string, by string) ([]string, error)
}

// SourceInfo ist die normalisierte Quelle für Resolver/UI.
type SourceInfo struct {
	SenderID     string           `json:"senderId"`
	Label        string           `json:"label"`
	NodeID       string           `json:"nodeId"`
	NodeLabel    string           `json:"nodeLabel"`
	InstanceID   string           `json:"instanceId,omitempty"`
	WorkflowID   string           `json:"workflowId,omitempty"`
	WorkflowName string           `json:"workflowName,omitempty"`
	Role         string           `json:"role,omitempty"`
	MediaType    string           `json:"mediaType"` // video | audio | data | ""
	Format       string           `json:"format"`
	Transport    string           `json:"transport,omitempty"`
	GroupHint    string           `json:"groupHint,omitempty"`
	ChannelCount int              `json:"channelCount,omitempty"`
	Online       bool             `json:"online"`
	Tags         []sourcetags.Tag `json:"tags"`
}

func mediaTypeOf(format string) string {
	const prefix = "urn:x-nmos:format:"
	if strings.HasPrefix(format, prefix) {
		return strings.TrimPrefix(format, prefix)
	}
	return ""
}

// buildSources ist reine Logik (testbar ohne Registry/DB): jeder Sender jedes
// Nodes wird eine Quelle; `roles` ordnet einen Node seiner Workflow-Rolle zu.
func buildSources(nodes []registry.NodeView, explicit map[sourcetags.Key][]string, roles func(nodeID string) (workflowID, workflowName, role string, ok bool)) []SourceInfo {
	out := []SourceInfo{}
	for _, n := range nodes {
		var wfID, wfName, role string
		if roles != nil {
			wfID, wfName, role, _ = roles(n.ID)
		}
		for _, s := range n.Senders {
			out = append(out, SourceInfo{
				SenderID:     s.ID,
				Label:        s.Label,
				NodeID:       n.ID,
				NodeLabel:    n.Label,
				InstanceID:   n.InstanceID,
				WorkflowID:   wfID,
				WorkflowName: wfName,
				Role:         role,
				MediaType:    mediaTypeOf(s.Format),
				Format:       s.Format,
				Transport:    s.Transport,
				GroupHint:    s.GroupHint,
				ChannelCount: s.ChannelCount,
				Online:       n.Online,
				Tags: sourcetags.Merge(
					explicit[sourcetags.Key{NodeID: n.ID, SenderLabel: s.Label}],
					sourcetags.Derive(s.Format, s.ChannelCount),
					s.DiscoveredTags,
				),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NodeLabel != out[j].NodeLabel {
			return out[i].NodeLabel < out[j].NodeLabel
		}
		if out[i].Label != out[j].Label {
			return out[i].Label < out[j].Label
		}
		return out[i].SenderID < out[j].SenderID
	})
	return out
}

func hasAllTags(s SourceInfo, want []string) bool {
	for _, w := range want {
		found := false
		for _, t := range s.Tags {
			if t.Tag == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func handleListSources(nodes NodeLister, store SourceTagStore, roles func(string) (string, string, string, bool), namer func(workflowID, role string) (string, bool)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		explicit, err := store.All()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		list := applySourceNames(buildSources(nodes.List(), explicit, roles), namer)
		// Optionale Filter: ?tag=a&tag=b (alle müssen passen), ?mediaType=audio, ?workflowId=…
		q := r.URL.Query()
		wantTags := q["tag"]
		media, wf := q.Get("mediaType"), q.Get("workflowId")
		filtered := list[:0]
		for _, s := range list {
			if media != "" && s.MediaType != media {
				continue
			}
			if wf != "" && s.WorkflowID != wf {
				continue
			}
			if !hasAllTags(s, wantTags) {
				continue
			}
			filtered = append(filtered, s)
		}
		writeJSON(w, http.StatusOK, filtered)
	}
}

func handlePutSourceTags(nodes NodeLister, store SourceTagStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		senderID := r.PathValue("senderId")
		var body struct {
			Tags []string `json:"tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		var key sourcetags.Key
		found := false
		for _, n := range nodes.List() {
			for _, s := range n.Senders {
				if s.ID == senderID {
					key, found = sourcetags.Key{NodeID: n.ID, SenderLabel: s.Label}, true
				}
			}
		}
		if !found {
			http.Error(w, "unknown sender", http.StatusNotFound)
			return
		}
		actor := actorFromRequest(r)
		tags, err := store.Set(key, body.Tags, actor)
		if err != nil {
			if errors.Is(err, sourcetags.ErrValidation) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actor, "source_tags", senderID, "set", map[string]any{"node": key.NodeID, "label": key.SenderLabel, "tags": tags})
		writeJSON(w, http.StatusOK, map[string]any{"senderId": senderID, "explicitTags": tags})
	}
}

// ---- Senken (Empfänger) mit Tags — Grundlage des X/Y-Panels ----------------------------------------
//
// GET /api/v1/sinks                 — alle Receiver als Senke, Tags je Herkunft
// PUT /api/v1/sinks/{receiverId}/tags — EXPLICIT-Tags ersetzen (global `configure`)
//
// Spiegelbild von /sources: dieselbe Tag-Sprache auf beiden Seiten macht die
// tag-basierte Schaltung möglich (Sender `audio.commentator` → Receiver
// `audio.commentator`). Der EXPLICIT-Overlay liegt im selben Speicher; der
// Schlüssel trägt das Präfix `receiver:` im Label-Feld, damit ein Sender und ein
// Receiver gleichen Namens am selben Node nie kollidieren (keine Migration nötig).

const sinkKeyPrefix = "receiver:"

// SinkInfo ist die normalisierte Senke für das X/Y-Panel.
type SinkInfo struct {
	ReceiverID   string           `json:"receiverId"`
	Label        string           `json:"label"`
	NodeID       string           `json:"nodeId"`
	NodeLabel    string           `json:"nodeLabel"`
	InstanceID   string           `json:"instanceId,omitempty"`
	WorkflowID   string           `json:"workflowId,omitempty"`
	WorkflowName string           `json:"workflowName,omitempty"`
	Role         string           `json:"role,omitempty"`
	MediaType    string           `json:"mediaType"`
	Format       string           `json:"format"`
	Transport    string           `json:"transport,omitempty"`
	Online       bool             `json:"online"`
	Tags         []sourcetags.Tag `json:"tags"`
}

func sinkKey(nodeID, label string) sourcetags.Key {
	return sourcetags.Key{NodeID: nodeID, SenderLabel: sinkKeyPrefix + label}
}

// buildSinks: reine Logik wie buildSources.
func buildSinks(nodes []registry.NodeView, explicit map[sourcetags.Key][]string, roles func(nodeID string) (workflowID, workflowName, role string, ok bool)) []SinkInfo {
	out := []SinkInfo{}
	for _, n := range nodes {
		var wfID, wfName, role string
		if roles != nil {
			wfID, wfName, role, _ = roles(n.ID)
		}
		for _, rc := range n.Receivers {
			out = append(out, SinkInfo{
				ReceiverID:   rc.ID,
				Label:        rc.Label,
				NodeID:       n.ID,
				NodeLabel:    n.Label,
				InstanceID:   n.InstanceID,
				WorkflowID:   wfID,
				WorkflowName: wfName,
				Role:         role,
				MediaType:    mediaTypeOf(rc.Format),
				Format:       rc.Format,
				Transport:    rc.Transport,
				Online:       n.Online,
				Tags: sourcetags.Merge(
					explicit[sinkKey(n.ID, rc.Label)],
					sourcetags.Derive(rc.Format, 0),
					rc.DiscoveredTags,
				),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NodeLabel != out[j].NodeLabel {
			return out[i].NodeLabel < out[j].NodeLabel
		}
		if out[i].Label != out[j].Label {
			return out[i].Label < out[j].Label
		}
		return out[i].ReceiverID < out[j].ReceiverID
	})
	return out
}

func handleListSinks(nodes NodeLister, store SourceTagStore, roles func(string) (string, string, string, bool)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		explicit, err := store.All()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		list := buildSinks(nodes.List(), explicit, roles)
		media := r.URL.Query().Get("mediaType")
		if media != "" {
			filtered := list[:0]
			for _, s := range list {
				if s.MediaType == media {
					filtered = append(filtered, s)
				}
			}
			list = filtered
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handlePutSinkTags(nodes NodeLister, store SourceTagStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		receiverID := r.PathValue("receiverId")
		var body struct {
			Tags []string `json:"tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		var key sourcetags.Key
		found := false
		for _, n := range nodes.List() {
			for _, rc := range n.Receivers {
				if rc.ID == receiverID {
					key, found = sinkKey(n.ID, rc.Label), true
				}
			}
		}
		if !found {
			http.Error(w, "unknown receiver", http.StatusNotFound)
			return
		}
		actor := actorFromRequest(r)
		tags, err := store.Set(key, body.Tags, actor)
		if err != nil {
			if errors.Is(err, sourcetags.ErrValidation) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actor, "sink_tags", receiverID, "set", map[string]any{"node": key.NodeID, "label": key.SenderLabel, "tags": tags})
		writeJSON(w, http.StatusOK, map[string]any{"receiverId": receiverID, "explicitTags": tags})
	}
}

// applySourceNames gibt Quellen, deren Node einem Modul-Eintrag (z. B. einer MCR-Leitung) gehört, den Anzeigenamen des Moduls:
// Bild „MCR/Event/Leitung“, Ton mit Zusatz „(Ton)“, Daten „(Daten)“. Gruppe und Node-Name folgen, damit Quellenauswahlen sie
// gemeinsam zeigen.
func applySourceNames(list []SourceInfo, namer func(workflowID, role string) (string, bool)) []SourceInfo {
	if namer == nil {
		return list
	}
	for i := range list {
		s := &list[i]
		name, ok := namer(s.WorkflowID, s.Role)
		if !ok {
			continue
		}
		old := s.NodeLabel
		s.NodeLabel = name
		switch s.MediaType {
		case "video":
			s.Label = name
		case "audio":
			s.Label = name + " (Ton)"
		default:
			s.Label = name + " (Daten)"
		}
		if old != "" && strings.HasPrefix(s.GroupHint, old) {
			s.GroupHint = name + strings.TrimPrefix(s.GroupHint, old)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].NodeLabel != list[j].NodeLabel {
			return list[i].NodeLabel < list[j].NodeLabel
		}
		if list[i].Label != list[j].Label {
			return list[i].Label < list[j].Label
		}
		return list[i].SenderID < list[j].SenderID
	})
	return list
}

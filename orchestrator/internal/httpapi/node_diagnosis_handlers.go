package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/timeline"
)

// Node-Diagnose (UMSETZUNG.md Kap. 72.7): alles zu EINEM Node an einem Ort — Befunde mit „Was tun?“, Prozess, Medienzustand,
// Pipeline, Ereignisse und Meldungen. Gesammelt wird über den eigenen Router mit den Anmeldedaten der aufrufenden Person.

const (
	diagWindow     = 24 * time.Hour
	diagRecent     = 15 * time.Minute
	diagTimelineN  = 40
	diagLogsN      = 40
	diagPipelineMS = 5 * time.Second
)

type nodeDiagnosis struct {
	GeneratedAt time.Time             `json:"generatedAt"`
	Level       support.Level         `json:"level"`
	Summary     string                `json:"summary"`
	Node        diagNode              `json:"node"`
	Instance    *launcher.Instance    `json:"instance,omitempty"`
	Process     *support.ProcessFacts `json:"process,omitempty"`
	Media       *support.MediaFacts   `json:"media,omitempty"`
	Findings    []support.Check       `json:"findings"`
	Timeline    []timeline.Item       `json:"timeline"`
	Logs        []logbus.Entry        `json:"logs"`
	// Pipelines: Antwort des Nodes (GET /diag/pipelines); PipelinesNote erklärt, warum sie fehlt.
	Pipelines     json.RawMessage `json:"pipelines,omitempty"`
	PipelinesNote string          `json:"pipelinesNote,omitempty"`
}

type diagNode struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Known      bool   `json:"known"`
	Online     bool   `json:"online"`
	InstanceID string `json:"instanceId,omitempty"`
	Type       string `json:"type,omitempty"`
	HostID     string `json:"hostId,omitempty"`
	Version    string `json:"version,omitempty"`
}

// handleNodeDiagnosis liefert GET /api/v1/nodes/{id}/diagnosis.
func handleNodeDiagnosis(h http.Handler, src *timeline.Sources) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		nodeID := r.PathValue("id")
		lang := requestLang(r)
		now := time.Now()
		d := nodeDiagnosis{GeneratedAt: now.UTC(), Findings: []support.Check{}, Timeline: []timeline.Item{}, Logs: []logbus.Entry{}}
		facts := support.NodeFacts{Label: nodeID}
		d.Node = diagNode{ID: nodeID}

		var nodes []registry.NodeView
		if loopbackJSON(ctx, h, r, "/api/v1/nodes", &nodes) {
			for _, n := range nodes {
				if n.ID != nodeID {
					continue
				}
				d.Node = diagNode{ID: n.ID, Label: n.Label, Known: true, Online: n.Online, InstanceID: n.InstanceID}
				if n.Build != nil {
					d.Node.Version = n.Build.Version
				}
				facts.Label, facts.Known, facts.Online = n.Label, true, n.Online
			}
		}
		var instance *launcher.Instance
		if d.Node.InstanceID != "" {
			var list []launcher.Instance
			if loopbackJSON(ctx, h, r, "/api/v1/instances", &list) {
				for i := range list {
					if list[i].ID == d.Node.InstanceID {
						instance = &list[i]
					}
				}
			}
		}
		if instance != nil {
			d.Instance = instance
			d.Node.Type, d.Node.HostID = instance.Type, instance.HostID
			facts.Instance = &support.InstanceFacts{Crashed: instance.Crashed, CrashMessage: instance.CrashMessage, RestartCount: instance.RestartCount,
				Outdated: instance.Outdated, CPUPercent: instance.CPUPercent, RSSBytes: instance.RSSBytes}
			// Prozessdetails nur für Prozesse auf dem Orchestrator-Rechner; bei Remote-Hosts bleiben CPU/RAM aus der Telemetrie.
			if instance.HostID == "" && instance.PID > 0 && !instance.Crashed {
				if p, err := support.ReadProcess(instance.PID); err == nil {
					d.Process, facts.Process = &p, &p
				}
			}
		}

		var kpi struct {
			Nodes []struct {
				NodeID          string                                 `json:"nodeId"`
				CurrentlyReady  bool                                   `json:"currentlyReady"`
				Availability    *float64                               `json:"availability"`
				ObservedSeconds float64                                `json:"observedSeconds"`
				Rates           map[string]struct{ Last, Avg float64 } `json:"rates"`
			} `json:"nodes"`
		}
		// Medienzustand nur für erreichbare Nodes: die letzte Kennzahl eines verschwundenen Nodes wäre veraltet („liefert“).
		if d.Node.Online && loopbackJSON(ctx, h, r, "/api/v1/kpi/media?window=1h", &kpi) {
			for _, k := range kpi.Nodes {
				if k.NodeID != nodeID {
					continue
				}
				m := &support.MediaFacts{Ready: k.CurrentlyReady, EverReady: k.Availability != nil && *k.Availability > 0, ObservedSecs: k.ObservedSeconds}
				if fps, ok := k.Rates["video_fps"]; ok {
					m.VideoFPS = &support.Rate{Last: fps.Last, Avg: fps.Avg}
				}
				d.Media, facts.Media = m, m
			}
		}

		// Pipeline des Nodes (nur Nodes mit GStreamer-Pipeline melden sie; sonst eine Erklärung statt eines Fehlers).
		if d.Node.Known && d.Node.Online {
			pctx, pcancel := context.WithTimeout(ctx, diagPipelineMS)
			body, code := loopbackGet(pctx, h, r, "/api/v1/nodes/"+nodeID+"/diag/pipelines")
			pcancel()
			var parsed struct {
				Pipelines []struct {
					Name     string `json:"name"`
					State    string `json:"state"`
					Elements []struct {
						Name    string `json:"name"`
						Factory string `json:"factory"`
						State   string `json:"state"`
						Level   *struct {
							Buffers, Bytes, MaxBuffers, MaxBytes uint64
						} `json:"level"`
					} `json:"elements"`
				} `json:"pipelines"`
			}
			switch {
			case code == http.StatusOK && json.Unmarshal(body, &parsed) == nil && len(parsed.Pipelines) > 0:
				d.Pipelines = body
				for _, p := range parsed.Pipelines {
					pf := support.PipelineFacts{Name: p.Name, State: p.State}
					for _, e := range p.Elements {
						ef := support.ElementFacts{Name: e.Name, Factory: e.Factory, State: e.State}
						if e.Level != nil {
							ef.Level = &support.QueueLevel{Buffers: e.Level.Buffers, Bytes: e.Level.Bytes, MaxBuffers: e.Level.MaxBuffers, MaxBytes: e.Level.MaxBytes}
						}
						pf.Elements = append(pf.Elements, ef)
					}
					facts.Pipelines = append(facts.Pipelines, pf)
				}
			case code == http.StatusOK:
				d.PipelinesNote = "none"
			case code == http.StatusNotFound || code == http.StatusMethodNotAllowed:
				d.PipelinesNote = "unsupported"
			default:
				d.PipelinesNote = "unavailable"
			}
		} else {
			d.PipelinesNote = "offline"
		}

		// Ereignisse (Abstürze, Neustarts, Medien …), Bedienungen an diesem Node und Fehlermeldungen.
		if src != nil {
			var subjects []string
			for _, s := range []string{d.Node.ID, d.Node.InstanceID} {
				if s != "" {
					subjects = append(subjects, s)
				}
			}
			if src.Store != nil {
				if rows, err := src.Store.QuerySubjects(now.Add(-diagWindow), now.Add(time.Minute), subjects, diagTimelineN); err == nil {
					for _, row := range rows {
						d.Timeline = append(d.Timeline, timeline.Item{ID: "e", At: row.At, Source: "event", Kind: row.Kind, Severity: row.Severity, Subject: row.Subject, Actor: row.Actor, Data: row.Data})
					}
				}
			}
			if src.Audit != nil && d.Node.Known {
				if entries, err := src.Audit.ListFiltered(audit.Filter{Terms: []string{nodeID}, Since: now.Add(-diagWindow), Limit: 15, ExcludeLike: []string{"/api/v1/layouts/%"}}); err == nil {
					for _, e := range entries {
						data, _ := json.Marshal(map[string]any{"method": e.Method, "path": e.Path, "status": e.Status, "nodeId": e.NodeID})
						sev := timeline.SevInfo
						if e.Status >= 400 {
							sev = timeline.SevWarn
						}
						d.Timeline = append(d.Timeline, timeline.Item{ID: "a", At: e.OccurredAt, Source: "audit", Kind: "audit", Severity: sev, Subject: e.NodeID, Actor: e.Username, Data: data})
					}
				}
			}
			if src.Logs != nil && d.Node.Known {
				if entries, err := src.Logs.Query(logbus.Filter{NodeID: nodeID, Levels: []string{"error", "warn"}, Since: now.Add(-diagWindow), Limit: diagLogsN}); err == nil {
					d.Logs = entries
					for _, e := range entries {
						if e.Level == "error" && now.Sub(e.OccurredAt) <= diagRecent {
							facts.RecentErrors++
						}
					}
				}
			}
		}
		sortTimeline(d.Timeline)

		d.Findings = support.EvaluateNode(facts, lang)
		d.Level, d.Summary = support.Summary(d.Findings, lang)
		writeJSON(w, http.StatusOK, d)
	}
}

// sortTimeline: neueste zuerst, höchstens diagTimelineN Zeilen.
func sortTimeline(items []timeline.Item) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].At.After(items[j-1].At); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

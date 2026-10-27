package timeline

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// SilentAfter: so lange ohne Telemetrie gilt ein Host als verstummt (wie im Selbsttest).
const SilentAfter = 30 * time.Second

// Recorder verwandelt den Ereignisstrom (sse.Hub) in Zeilen. Zustandswechsel, für die es kein eigenes Ereignis gibt
// (Medien bereit/weg, Host verstummt, Uhr), werden aus den Health- und Telemetrie-Ereignissen abgeleitet; der erste
// Eindruck eines Nodes/Hosts ist nie ein Ereignis, nur eine Änderung gegenüber dem bekannten Zustand.
type Recorder struct {
	// HostLabel/NodeLabel (optional) liefern den Anzeigenamen zu einer ID.
	HostLabel func(id string) string

	mu         sync.Mutex
	nodeReady  map[string]bool
	hostClock  map[string]bool // true = synchron
	hostSeen   map[string]time.Time
	hostSilent map[string]bool
	hostLabels map[string]string
	wfStatus   map[string]string
}

func NewRecorder() *Recorder {
	return &Recorder{nodeReady: map[string]bool{}, hostClock: map[string]bool{}, hostSeen: map[string]time.Time{}, hostSilent: map[string]bool{}, hostLabels: map[string]string{}, wfStatus: map[string]string{}}
}

// Observe wertet ein Hub-Ereignis aus und liefert die daraus entstehenden Zeilen.
func (r *Recorder) Observe(ev sse.Event, now time.Time) []Event {
	switch {
	case ev.Type == "instance.crashed", ev.Type == "instance.restarted":
		var inst struct {
			ID           string `json:"id"`
			Type         string `json:"type"`
			Label        string `json:"label"`
			HostID       string `json:"hostId"`
			CrashMessage string `json:"crashMessage"`
			RestartCount int    `json:"restartCount"`
		}
		_ = json.Unmarshal(ev.Data, &inst)
		sev := SevWarn
		if ev.Type == "instance.crashed" {
			sev = SevError
		}
		msg := inst.CrashMessage
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return []Event{{At: now, Kind: ev.Type, Severity: sev, Subject: inst.ID, Data: map[string]any{"label": inst.Label, "type": inst.Type, "hostId": inst.HostID, "restarts": inst.RestartCount, "message": msg}}}
	case ev.Type == "workflow.failover":
		return []Event{{At: now, Kind: ev.Type, Severity: SevError, Subject: field(ev.Data, "workflowId"), Data: raw(ev.Data)}}
	case ev.Type == "workflow.updated":
		return r.observeWorkflow(ev.Data, now)
	case ev.Type == "workflow.migration", ev.Type == "host.registered", ev.Type == "host.removed", ev.Type == "host.maintenance",
		ev.Type == "edge.added", ev.Type == "edge.removed":
		sev := SevInfo
		if ev.Type == "host.removed" {
			sev = SevWarn
		}
		return []Event{{At: now, Kind: ev.Type, Severity: sev, Subject: firstField(ev.Data, "id", "workflowId", "hostId", "receiverId", "receiver"), Data: raw(ev.Data)}}
	case strings.HasPrefix(ev.Type, "omp.health."):
		return r.observeHealth(strings.TrimPrefix(ev.Type, "omp.health."), ev.Data, now)
	case strings.HasPrefix(ev.Type, "omp.host.") && strings.HasSuffix(ev.Type, ".metrics"):
		return r.observeHost(strings.TrimSuffix(strings.TrimPrefix(ev.Type, "omp.host."), ".metrics"), ev.Data, now)
	}
	return nil
}

// observeWorkflow: „workflow.updated“ feuert bei jeder Änderung; auf die Zeitleiste kommt nur ein Wechsel des Zustands
// (gestartet, gestoppt, fehlgeschlagen). Der erste Eindruck ist kein Ereignis.
func (r *Recorder) observeWorkflow(data json.RawMessage, now time.Time) []Event {
	var wf struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if json.Unmarshal(data, &wf) != nil || wf.ID == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, known := r.wfStatus[wf.ID]
	r.wfStatus[wf.ID] = wf.Status
	if !known || prev == wf.Status {
		return nil
	}
	sev := SevInfo
	if wf.Status == "failed" || wf.Error != "" {
		sev = SevError
	}
	return []Event{{At: now, Kind: "workflow.status", Severity: sev, Subject: wf.ID, Data: map[string]any{"name": wf.Name, "status": wf.Status, "previous": prev, "error": wf.Error}}}
}

func (r *Recorder) observeHealth(id string, data json.RawMessage, now time.Time) []Event {
	var h struct {
		Label      string `json:"label"`
		MediaReady *bool  `json:"media_ready"`
	}
	if json.Unmarshal(data, &h) != nil || h.MediaReady == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, known := r.nodeReady[id]
	r.nodeReady[id] = *h.MediaReady
	if !known || prev == *h.MediaReady {
		return nil
	}
	if *h.MediaReady {
		return []Event{{At: now, Kind: "node.ready", Severity: SevInfo, Subject: id, Data: map[string]any{"label": h.Label}}}
	}
	return []Event{{At: now, Kind: "node.notready", Severity: SevError, Subject: id, Data: map[string]any{"label": h.Label}}}
}

func (r *Recorder) observeHost(id string, data json.RawMessage, now time.Time) []Event {
	var m struct {
		Goodbye bool `json:"goodbye"`
		Clock   *struct {
			Synced bool `json:"synced"`
		} `json:"clock"`
	}
	_ = json.Unmarshal(data, &m)
	r.mu.Lock()
	defer r.mu.Unlock()
	label := r.label(id)
	var out []Event
	if r.hostSilent[id] {
		r.hostSilent[id] = false
		out = append(out, Event{At: now, Kind: "host.resumed", Severity: SevInfo, Subject: id, Data: map[string]any{"label": label}})
	}
	if m.Goodbye {
		delete(r.hostSeen, id) // absichtlich abgemeldet: Schweigen ist kein Ausfall
	} else {
		r.hostSeen[id] = now
	}
	if m.Clock != nil {
		prev, known := r.hostClock[id]
		r.hostClock[id] = m.Clock.Synced
		if known && prev != m.Clock.Synced {
			if m.Clock.Synced {
				out = append(out, Event{At: now, Kind: "host.clock.ok", Severity: SevInfo, Subject: id, Data: map[string]any{"label": label}})
			} else {
				out = append(out, Event{At: now, Kind: "host.clock.lost", Severity: SevWarn, Subject: id, Data: map[string]any{"label": label}})
			}
		}
	}
	return out
}

func (r *Recorder) label(id string) string {
	if l, ok := r.hostLabels[id]; ok {
		return l
	}
	l := id
	if r.HostLabel != nil {
		if v := r.HostLabel(id); v != "" {
			l = v
		}
	}
	r.hostLabels[id] = l
	return l
}

// Tick erkennt verstummte Hosts (periodisch aufrufen).
func (r *Recorder) Tick(now time.Time) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Event
	for id, seen := range r.hostSeen {
		if !r.hostSilent[id] && now.Sub(seen) > SilentAfter {
			r.hostSilent[id] = true
			out = append(out, Event{At: seen.Add(SilentAfter), Kind: "host.silent", Severity: SevError, Subject: id, Data: map[string]any{"label": r.label(id)}})
		}
	}
	return out
}

// Run liest den Hub und schreibt in sink, bis ctx endet. Liest ohne Umweg, damit der kleine Puffer des Hubs nicht überläuft.
func (r *Recorder) Run(ctx context.Context, hub *sse.Hub, sink func(Event)) {
	ch, cancel := hub.Subscribe()
	defer cancel()
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			for _, e := range r.Observe(ev, time.Now()) {
				sink(e)
			}
		case now := <-tick.C:
			for _, e := range r.Tick(now) {
				sink(e)
			}
		}
	}
}

func raw(data json.RawMessage) map[string]any {
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return map[string]any{}
	}
	return m
}

func field(data json.RawMessage, key string) string {
	if v, ok := raw(data)[key].(string); ok {
		return v
	}
	return ""
}

func firstField(data json.RawMessage, keys ...string) string {
	for _, k := range keys {
		if v := field(data, k); v != "" {
			return v
		}
	}
	return ""
}

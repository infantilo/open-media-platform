package alertsink

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// Medien-Gesundheit und Schwellwerte (Audit 2026-10-23 M7): „Prozess lebt“ sagt nichts darüber, ob ein Sendeweg noch Bild/Ton liefert. Nodes melden mit jedem Health-Ereignis
// (omp.health.<id>) `media_ready`; fällt das für länger als MediaGrace auf false, nachdem es true war, oder bleibt das Ereignis ganz aus, geht ein Alarm hinaus.

// HealthWatch hält die Schwellen; Null-Werte nehmen die Standardwerte.
type HealthWatch struct {
	Sink *Sink
	// MediaGrace: so lange darf media_ready false sein, bevor Alarm kommt (Umschaltungen und Neustarts sind kurz).
	MediaGrace time.Duration
	// Silence: so lange darf ein bekannter Node kein Health-Ereignis senden.
	Silence time.Duration
	Now     func() time.Time
}

type nodeHealth struct {
	label                       string
	lastSeen                    time.Time
	everReady                   bool
	notReadyAt                  time.Time // Nullwert = bereit
	alertedMedia, alertedSilent bool
}

func (w *HealthWatch) defaults() {
	if w.MediaGrace <= 0 {
		w.MediaGrace = 15 * time.Second
	}
	if w.Silence <= 0 {
		w.Silence = 30 * time.Second
	}
	if w.Now == nil {
		w.Now = time.Now
	}
}

// Run wertet Health-Ereignisse aus dem SSE-Hub aus, bis ctx endet.
func (w *HealthWatch) Run(ctx context.Context, hub *sse.Hub) {
	if w.Sink == nil {
		return
	}
	w.defaults()
	ch, cancel := hub.Subscribe()
	defer cancel()
	nodes := map[string]*nodeHealth{}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			w.observe(nodes, ev)
		case <-tick.C:
			w.evaluate(nodes)
		}
	}
}

func (w *HealthWatch) observe(nodes map[string]*nodeHealth, ev sse.Event) {
	const prefix = "omp.health."
	if !strings.HasPrefix(ev.Type, prefix) {
		return
	}
	id := strings.TrimPrefix(ev.Type, prefix)
	var p struct {
		Label      string `json:"label"`
		Status     string `json:"status"`
		MediaReady *bool  `json:"media_ready"`
	}
	if json.Unmarshal(ev.Data, &p) != nil {
		return
	}
	n := nodes[id]
	if n == nil {
		n = &nodeHealth{}
		nodes[id] = n
	}
	now := w.Now()
	if p.Label != "" {
		n.label = p.Label
	}
	if n.alertedSilent {
		w.Sink.Send(Alert{Kind: "node-recovered", Subject: id, Name: n.label, Message: "Node meldet sich wieder"})
	}
	n.lastSeen, n.alertedSilent = now, false
	if p.MediaReady == nil {
		return
	}
	switch {
	case *p.MediaReady:
		if n.alertedMedia {
			w.Sink.Send(Alert{Kind: "media-recovered", Subject: id, Name: n.label, Message: "liefert wieder Medien"})
		}
		n.everReady, n.alertedMedia, n.notReadyAt = true, false, time.Time{}
	case n.everReady && n.notReadyAt.IsZero():
		n.notReadyAt = now
	}
}

func (w *HealthWatch) evaluate(nodes map[string]*nodeHealth) {
	now := w.Now()
	for id, n := range nodes {
		if !n.notReadyAt.IsZero() && !n.alertedMedia && now.Sub(n.notReadyAt) >= w.MediaGrace {
			n.alertedMedia = true
			w.Sink.Send(Alert{Kind: "media-lost", Subject: id, Name: n.label, Message: fmt.Sprintf("liefert seit %d s keine Medien mehr (media_ready=false)", int(now.Sub(n.notReadyAt).Seconds()))})
		}
		if !n.alertedSilent && now.Sub(n.lastSeen) >= w.Silence {
			n.alertedSilent = true
			w.Sink.Send(Alert{Kind: "node-silent", Subject: id, Name: n.label, Message: fmt.Sprintf("seit %d s kein Lebenszeichen", int(now.Sub(n.lastSeen).Seconds()))})
		}
	}
}

// Load beschreibt die Auslastung eines Hosts für die Schwellwert-Prüfung.
type Load struct {
	Name       string
	CPUPercent float64
	MemPercent float64
}

// WatchLoad meldet, wenn ein Host länger als `sustain` über cpuMax/memMax (Prozent) liegt, und wenn er sich wieder erholt. snapshot liefert nur Hosts, die online sind.
func WatchLoad(ctx context.Context, every, sustain time.Duration, cpuMax, memMax float64, snapshot func() map[string]Load, s *Sink) {
	if s == nil {
		return
	}
	type st struct {
		since   time.Time
		alerted bool
	}
	cpu, mem := map[string]*st{}, map[string]*st{}
	check := func(m map[string]*st, id, name, what string, over bool, val, limit float64, now time.Time) {
		e := m[id]
		if e == nil {
			e = &st{}
			m[id] = e
		}
		switch {
		case over && e.since.IsZero():
			e.since = now
		case !over:
			if e.alerted {
				s.Send(Alert{Kind: "load-recovered", Subject: id + "/" + what, Name: name, Message: what + " wieder unter der Schwelle"})
			}
			e.since, e.alerted = time.Time{}, false
		}
		if over && !e.alerted && now.Sub(e.since) >= sustain {
			e.alerted = true
			s.Send(Alert{Kind: "load-high", Subject: id + "/" + what, Name: name, Message: fmt.Sprintf("%s seit %d s bei %.0f %% (Schwelle %.0f %%)", what, int(now.Sub(e.since).Seconds()), val, limit)})
		}
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		now := s.now()
		cur := snapshot()
		for id, l := range cur {
			check(cpu, id, l.Name, "CPU", l.CPUPercent > cpuMax, l.CPUPercent, cpuMax, now)
			check(mem, id, l.Name, "Speicher", l.MemPercent > memMax, l.MemPercent, memMax, now)
		}
		for id := range cpu {
			if _, ok := cur[id]; !ok {
				delete(cpu, id)
				delete(mem, id)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

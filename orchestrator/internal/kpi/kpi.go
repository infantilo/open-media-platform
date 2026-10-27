// Package kpi führt Medien-Kennzahlen je Node (Audit 2026-10-23 M7: „keine Medien-KPIs“): aus den Health-Ereignissen (omp.health.<id>, Feld media_ready) entstehen
// Verfügbarkeit (Anteil der beobachteten Zeit, in der der Node Medien lieferte), Zahl und Dauer der Ausfälle. Der Verlauf wird minutenweise im Speicher gehalten (24 h,
// geht beim Neustart des Orchestrators verloren — es sind Betriebskennzahlen, kein Archiv). Zeit ohne Ereignisse (Node aus, Orchestrator aus) zählt nicht als
// beobachtet und verfälscht die Verfügbarkeit nicht; ob ein Node schweigt, melden die Alarme (internal/alertsink).
package kpi

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

const (
	// Retention: so lange werden Minutenwerte gehalten.
	Retention = 24 * time.Hour
	// MaxGap: größer als dieser Abstand zwischen zwei Ereignissen gilt als nicht beobachtet.
	MaxGap = 30 * time.Second
	// maxOutages je Node (jüngste).
	maxOutages = 20
)

type bucket struct{ ready, notReady float64 } // Sekunden

// Outage ist ein Ausfall (media_ready=false nach zuvor true).
type Outage struct {
	Start   time.Time `json:"start"`
	Seconds float64   `json:"seconds"`
	Ongoing bool      `json:"ongoing,omitempty"`
}

// rateBucket: Minutenwerte einer Raten-Kennzahl (Summe/Anzahl für das Mittel, Minimum).
type rateBucket struct {
	sum, min float64
	count    int
}

type rateSeries struct {
	last    float64
	buckets map[int64]*rateBucket
}

// Rate ist die Auswertung einer Raten-Kennzahl (z. B. video_fps) über das Fenster.
type Rate struct {
	Last float64 `json:"last"`
	Avg  float64 `json:"avg"`
	Min  float64 `json:"min"`
}

type node struct {
	rates     map[string]*rateSeries
	label     string
	lastAt    time.Time
	known     bool
	ready     bool
	everReady bool
	buckets   map[int64]*bucket // Minute (Unix/60)
	outages   []Outage
}

// Tracker sammelt die Ereignisse; nebenläufig sicher.
type Tracker struct {
	mu    sync.Mutex
	nodes map[string]*node
	now   func() time.Time
}

func NewTracker() *Tracker { return &Tracker{nodes: map[string]*node{}, now: time.Now} }

// Observe verbucht ein Health-Ereignis. ready=nil (Node meldet kein media_ready) wird ignoriert.
func (t *Tracker) Observe(id, label string, ready *bool, kpis map[string]float64, at time.Time) {
	if ready == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	n := t.nodes[id]
	if n == nil {
		n = &node{buckets: map[int64]*bucket{}}
		t.nodes[id] = n
	}
	if label != "" {
		n.label = label
	}
	for name, v := range kpis {
		if n.rates == nil {
			n.rates = map[string]*rateSeries{}
		}
		rs := n.rates[name]
		if rs == nil {
			rs = &rateSeries{buckets: map[int64]*rateBucket{}}
			n.rates[name] = rs
		}
		rs.last = v
		m := at.Unix() / 60
		b := rs.buckets[m]
		if b == nil {
			b = &rateBucket{min: v}
			rs.buckets[m] = b
		}
		b.sum += v
		b.count++
		if v < b.min {
			b.min = v
		}
	}
	if n.known {
		if gap := at.Sub(n.lastAt); gap > 0 && gap <= MaxGap {
			n.account(n.lastAt, at, n.ready)
		}
	}
	if n.known && n.ready && !*ready {
		n.outages = append(n.outages, Outage{Start: at, Ongoing: true})
		if len(n.outages) > maxOutages {
			n.outages = n.outages[len(n.outages)-maxOutages:]
		}
	}
	if n.known && !n.ready && *ready && len(n.outages) > 0 {
		o := &n.outages[len(n.outages)-1]
		if o.Ongoing {
			o.Ongoing, o.Seconds = false, at.Sub(o.Start).Seconds()
		}
	}
	n.known, n.ready, n.lastAt = true, *ready, at
	if *ready {
		n.everReady = true
	}
	t.prune(n, at)
}

// account verteilt das Intervall [from,to) auf die Minuten-Eimer.
func (n *node) account(from, to time.Time, ready bool) {
	for from.Before(to) {
		minute := from.Unix() / 60
		end := time.Unix((minute+1)*60, 0)
		if end.After(to) {
			end = to
		}
		b := n.buckets[minute]
		if b == nil {
			b = &bucket{}
			n.buckets[minute] = b
		}
		if ready {
			b.ready += end.Sub(from).Seconds()
		} else {
			b.notReady += end.Sub(from).Seconds()
		}
		from = end
	}
}

func (t *Tracker) prune(n *node, now time.Time) {
	cut := now.Add(-Retention).Unix() / 60
	for m := range n.buckets {
		if m < cut {
			delete(n.buckets, m)
		}
	}
	for _, rs := range n.rates {
		for m := range rs.buckets {
			if m < cut {
				delete(rs.buckets, m)
			}
		}
	}
}

// NodeKPI ist die Kennzahl eines Nodes über ein Zeitfenster.
type NodeKPI struct {
	NodeID          string   `json:"nodeId"`
	Label           string   `json:"label"`
	CurrentlyReady  bool     `json:"currentlyReady"`
	Availability    *float64 `json:"availability"` // 0…1; nil = noch nichts beobachtet
	ObservedSeconds float64  `json:"observedSeconds"`
	Outages         int      `json:"outages"`
	LongestOutageS  float64  `json:"longestOutageSeconds"`
	LastOutage      *Outage  `json:"lastOutage,omitempty"`
	// Rates: Raten-Kennzahlen des Nodes (z. B. video_fps) über das Fenster.
	Rates map[string]Rate `json:"rates,omitempty"`
}

// Snapshot liefert die Kennzahlen aller Nodes für die letzten `window` (höchstens Retention), schlechteste Verfügbarkeit zuerst.
func (t *Tracker) Snapshot(window time.Duration) []NodeKPI {
	if window <= 0 || window > Retention {
		window = Retention
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	from := now.Add(-window)
	cutMinute := from.Unix() / 60
	out := make([]NodeKPI, 0, len(t.nodes))
	for id, n := range t.nodes {
		var ready, notReady float64
		for m, b := range n.buckets {
			if m >= cutMinute {
				ready += b.ready
				notReady += b.notReady
			}
		}
		k := NodeKPI{NodeID: id, Label: n.label, CurrentlyReady: n.known && n.ready, ObservedSeconds: ready + notReady}
		if ready+notReady > 0 {
			a := ready / (ready + notReady)
			k.Availability = &a
		}
		for name, rs := range n.rates {
			var sum, min float64
			count := 0
			first := true
			for m, b := range rs.buckets {
				if m < cutMinute {
					continue
				}
				sum += b.sum
				count += b.count
				if first || b.min < min {
					min, first = b.min, false
				}
			}
			if count > 0 {
				if k.Rates == nil {
					k.Rates = map[string]Rate{}
				}
				k.Rates[name] = Rate{Last: rs.last, Avg: sum / float64(count), Min: min}
			}
		}
		for i := range n.outages {
			o := n.outages[i]
			if o.Ongoing {
				o.Seconds = now.Sub(o.Start).Seconds()
			}
			if o.Start.Add(time.Duration(o.Seconds * float64(time.Second))).Before(from) {
				continue
			}
			k.Outages++
			if o.Seconds > k.LongestOutageS {
				k.LongestOutageS = o.Seconds
			}
			oc := o
			k.LastOutage = &oc
		}
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		ai, aj := 2.0, 2.0
		if out[i].Availability != nil {
			ai = *out[i].Availability
		}
		if out[j].Availability != nil {
			aj = *out[j].Availability
		}
		if ai != aj {
			return ai < aj
		}
		return out[i].Label < out[j].Label
	})
	return out
}

// Forget vergisst einen Node (z. B. nach dem Stoppen der Instanz).
func (t *Tracker) Forget(id string) {
	t.mu.Lock()
	delete(t.nodes, id)
	t.mu.Unlock()
}

// FromEvent wertet ein SSE-Ereignis aus; ok=false, wenn es kein Health-Ereignis mit media_ready ist.
func FromEvent(ev sse.Event) (id, label string, ready *bool, kpis map[string]float64, ok bool) {
	const prefix = "omp.health."
	if !strings.HasPrefix(ev.Type, prefix) {
		return "", "", nil, nil, false
	}
	var p struct {
		Label      string             `json:"label"`
		MediaReady *bool              `json:"media_ready"`
		KPIs       map[string]float64 `json:"kpis"`
	}
	if json.Unmarshal(ev.Data, &p) != nil || p.MediaReady == nil {
		return "", "", nil, nil, false
	}
	return strings.TrimPrefix(ev.Type, prefix), p.Label, p.MediaReady, p.KPIs, true
}

// Package blackbox ist der Flugschreiber (UMSETZUNG.md Kap. 72.10): ein Ringpuffer mit den letzten Minuten der Node-Kennzahlen (Medien bereit,
// Bildrate …) und der Prozesswerte (CPU, Speicher) in feiner Auflösung. Aus ihm entsteht beim „Einfrieren“ die Messreihe, die man hinterher
// braucht, um zu sehen, WAS VOR einer Störung geschah — Health-Kennzahlen und Zeitleiste allein sind dafür zu grob.
package blackbox

import (
	"sort"
	"sync"
	"time"
)

const (
	// Interval: Mindestabstand zweier gespeicherter Punkte je Reihe.
	Interval = 5 * time.Second
	// Window: so lange wird zurückgehalten.
	Window = 15 * time.Minute
	// maxSeries begrenzt die Zahl der Reihen (ein Node-/Prozess-Strom, der nie endet, soll den Speicher nicht füllen).
	maxSeries = 500
)

// NodeSample ist ein Punkt der Health-Kennzahlen eines Nodes.
type NodeSample struct {
	T     time.Time          `json:"t"`
	Ready *bool              `json:"ready,omitempty"`
	KPIs  map[string]float64 `json:"kpis,omitempty"`
}

// ProcSample ist ein Punkt der Prozesswerte einer Instanz.
type ProcSample struct {
	T   time.Time `json:"t"`
	CPU *float64  `json:"cpuPercent,omitempty"`
	RSS *uint64   `json:"rssBytes,omitempty"`
}

// NodeSeries und ProcSeries sind die ausgelesenen Reihen.
type NodeSeries struct {
	ID      string       `json:"id"`
	Label   string       `json:"label"`
	Samples []NodeSample `json:"samples"`
}

type ProcSeries struct {
	InstanceID string       `json:"instanceId"`
	Label      string       `json:"label"`
	Samples    []ProcSample `json:"samples"`
}

// Series ist alles, was im Fenster aufgezeichnet wurde.
type Series struct {
	From  time.Time    `json:"from"`
	To    time.Time    `json:"to"`
	Nodes []NodeSeries `json:"nodes"`
	Procs []ProcSeries `json:"processes"`
}

type nodeRing struct {
	label   string
	samples []NodeSample
}

type procRing struct {
	label   string
	samples []ProcSample
}

// Recorder hält die Ringpuffer. Alles ist im Arbeitsspeicher: ein Neustart leert ihn (dokumentierte Grenze).
type Recorder struct {
	mu    sync.Mutex
	now   func() time.Time
	nodes map[string]*nodeRing
	procs map[string]*procRing
}

func New() *Recorder {
	return &Recorder{now: time.Now, nodes: map[string]*nodeRing{}, procs: map[string]*procRing{}}
}

// Record speichert die Kennzahlen eines Nodes (Health-Ereignis). Punkte, die dichter als Interval liegen, entfallen — der Wechsel der
// Bereitschaft wird aber immer gespeichert, er ist der wichtigste Punkt der Reihe.
func (r *Recorder) Record(id, label string, ready *bool, kpis map[string]float64, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ring := r.nodes[id]
	if ring == nil {
		if len(r.nodes) >= maxSeries {
			return
		}
		ring = &nodeRing{}
		r.nodes[id] = ring
	}
	ring.label = label
	if n := len(ring.samples); n > 0 {
		last := ring.samples[n-1]
		changed := (ready == nil) != (last.Ready == nil) || (ready != nil && last.Ready != nil && *ready != *last.Ready)
		if at.Sub(last.T) < Interval && !changed {
			return
		}
	}
	s := NodeSample{T: at, Ready: ready}
	if len(kpis) > 0 {
		s.KPIs = make(map[string]float64, len(kpis))
		for k, v := range kpis {
			s.KPIs[k] = v
		}
	}
	ring.samples = append(trimNodes(ring.samples, at), s)
}

// RecordProc speichert die Prozesswerte einer Instanz.
func (r *Recorder) RecordProc(instanceID, label string, cpu *float64, rss *uint64, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ring := r.procs[instanceID]
	if ring == nil {
		if len(r.procs) >= maxSeries {
			return
		}
		ring = &procRing{}
		r.procs[instanceID] = ring
	}
	ring.label = label
	if n := len(ring.samples); n > 0 && at.Sub(ring.samples[n-1].T) < Interval {
		return
	}
	ring.samples = append(trimProcs(ring.samples, at), ProcSample{T: at, CPU: cpu, RSS: rss})
}

func trimNodes(s []NodeSample, now time.Time) []NodeSample {
	cut := 0
	for cut < len(s) && now.Sub(s[cut].T) > Window {
		cut++
	}
	if cut == 0 {
		return s
	}
	return append([]NodeSample(nil), s[cut:]...)
}

func trimProcs(s []ProcSample, now time.Time) []ProcSample {
	cut := 0
	for cut < len(s) && now.Sub(s[cut].T) > Window {
		cut++
	}
	if cut == 0 {
		return s
	}
	return append([]ProcSample(nil), s[cut:]...)
}

// Forget verwirft die Reihe eines gelöschten Nodes oder einer gelöschten Instanz sofort. Wenn ein Node verschwindet, sind seine letzten
// Minuten gerade das Interessante — die Reihen veralten deshalb von selbst (Window), werden nicht beim Verschwinden gelöscht. Forget ist für
// Tests und für ausdrückliches Aufräumen.
func (r *Recorder) Forget(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.nodes, id)
	delete(r.procs, id)
}

// Window liefert die Reihen der letzten d (höchstens Window); leere und völlig veraltete Reihen fehlen.
func (r *Recorder) Window(d time.Duration) Series {
	if d <= 0 || d > Window {
		d = Window
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	out := Series{From: now.Add(-d), To: now, Nodes: []NodeSeries{}, Procs: []ProcSeries{}}
	for id, ring := range r.nodes {
		var pts []NodeSample
		for _, s := range ring.samples {
			if !s.T.Before(out.From) {
				pts = append(pts, s)
			}
		}
		if len(pts) > 0 {
			out.Nodes = append(out.Nodes, NodeSeries{ID: id, Label: ring.label, Samples: pts})
		}
	}
	for id, ring := range r.procs {
		var pts []ProcSample
		for _, s := range ring.samples {
			if !s.T.Before(out.From) {
				pts = append(pts, s)
			}
		}
		if len(pts) > 0 {
			out.Procs = append(out.Procs, ProcSeries{InstanceID: id, Label: ring.label, Samples: pts})
		}
	}
	sort.Slice(out.Nodes, func(i, j int) bool { return out.Nodes[i].Label < out.Nodes[j].Label })
	sort.Slice(out.Procs, func(i, j int) bool { return out.Procs[i].Label < out.Procs[j].Label })
	return out
}

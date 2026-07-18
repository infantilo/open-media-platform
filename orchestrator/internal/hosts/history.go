package hosts

import (
	"sync"
	"time"
)

// Kapitel 14 Teil 1 (docs/END-GOAL-FEATURES.md §14.3a, §14.4): Historie
// der zuletzt bekannten Host-Telemetrie, zweistufig wie im Ziel-Design
// beschrieben — Rohwerte (Sample-Auflösung, ~1h) für kurzfristige
// Sparklines, danach 1-Minuten-Aggregate (min/avg/max) für ~24h, damit
// ein Tagesüberblick nicht 720 Rohpunkte pro Host im Speicher braucht.
// Bewusst in-memory (§14.5 offene Frage 2, Empfehlung "für jetzt"): ein
// Orchestrator-Neustart leert die Kurve, dokumentiertes Verhalten, keine
// Postgres-Persistenz in dieser Teilscheibe.

const (
	rawSampleInterval = 5 * time.Second
	rawWindow         = time.Hour
	rawCapacity       = int(rawWindow / rawSampleInterval) // 720

	aggregateBucket   = time.Minute
	aggregateWindow   = 24 * time.Hour
	aggregateCapacity = int(aggregateWindow / aggregateBucket) // 1440
)

// Sample ist ein einzelner Telemetrie-Zeitpunkt (Rohauflösung).
type Sample struct {
	Timestamp  time.Time `json:"timestamp"`
	CPUPercent float64   `json:"cpuPercent"`
	MemPercent float64   `json:"memPercent"`
}

// Aggregate fasst alle Samples innerhalb eines abgeschlossenen
// 1-Minuten-Fensters zu Min/Ø/Max zusammen.
type Aggregate struct {
	BucketStart time.Time `json:"bucketStart"`
	CPUMin      float64   `json:"cpuMin"`
	CPUAvg      float64   `json:"cpuAvg"`
	CPUMax      float64   `json:"cpuMax"`
	MemMin      float64   `json:"memMin"`
	MemAvg      float64   `json:"memAvg"`
	MemMax      float64   `json:"memMax"`
	SampleCount int       `json:"sampleCount"`
}

// Summary ist die Min/Ø/Max-Zusammenfassung über das gesamte
// zurückgelieferte Fenster (unabhängig davon, ob es aus Roh- oder
// Aggregat-Daten stammt) — Grundlage der Min/Ø/Max-Spalten (§14.3a).
type Summary struct {
	CPUMin      float64 `json:"cpuMin"`
	CPUAvg      float64 `json:"cpuAvg"`
	CPUMax      float64 `json:"cpuMax"`
	MemMin      float64 `json:"memMin"`
	MemAvg      float64 `json:"memAvg"`
	MemMax      float64 `json:"memMax"`
	SampleCount int     `json:"sampleCount"`
}

// HistoryWindow ist die Antwort auf eine Fensterabfrage — "raw", wenn
// window <= rawWindow (Sparkline in Sample-Auflösung), sonst
// "aggregate" (1-Minuten-Punkte, älter als rawWindow ohnehin nur noch
// als Aggregat vorhanden).
type HistoryWindow struct {
	Resolution string      `json:"resolution"`
	Samples    []Sample    `json:"samples,omitempty"`
	Aggregates []Aggregate `json:"aggregates,omitempty"`
	Summary    Summary     `json:"summary"`
}

type hostHistory struct {
	raw        []Sample
	aggregates []Aggregate

	// Nicht abgeschlossener aktueller 1-Minuten-Eimer.
	bucketStart   time.Time
	bucketSamples []Sample
}

// History hält pro Host einen Ringpuffer aus Roh-Samples plus einen
// zweiten aus 1-Minuten-Aggregaten, nebenläufig sicher nutzbar (gleiches
// Muster wie Tracker).
type History struct {
	mu     sync.Mutex
	byHost map[string]*hostHistory
}

// NewHistory erstellt eine leere Historie.
func NewHistory() *History {
	return &History{byHost: make(map[string]*hostHistory)}
}

// Record fügt einen Telemetrie-Punkt hinzu — vom selben Aufrufer wie
// Tracker.Touch aufgerufen (main.go), gleicher Payload, kein zweites
// Parsing. memPercent wird hier statt im Aufrufer berechnet (einzige
// Ableitung aus MemUsed/MemTotal, an einer Stelle).
func (h *History) Record(hostID string, m Metrics) {
	memPercent := 0.0
	if m.MemTotalBytes > 0 {
		memPercent = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
	}
	sample := Sample{Timestamp: m.ReceivedAt, CPUPercent: m.CPUPercent, MemPercent: memPercent}

	h.mu.Lock()
	defer h.mu.Unlock()

	hh := h.byHost[hostID]
	if hh == nil {
		hh = &hostHistory{}
		h.byHost[hostID] = hh
	}

	hh.raw = append(hh.raw, sample)
	if len(hh.raw) > rawCapacity {
		hh.raw = hh.raw[len(hh.raw)-rawCapacity:]
	}

	bucket := sample.Timestamp.Truncate(aggregateBucket)
	if hh.bucketStart.IsZero() {
		hh.bucketStart = bucket
	}
	if !bucket.Equal(hh.bucketStart) {
		hh.aggregates = append(hh.aggregates, aggregateFrom(hh.bucketStart, hh.bucketSamples))
		if len(hh.aggregates) > aggregateCapacity {
			hh.aggregates = hh.aggregates[len(hh.aggregates)-aggregateCapacity:]
		}
		hh.bucketStart = bucket
		hh.bucketSamples = nil
	}
	hh.bucketSamples = append(hh.bucketSamples, sample)
}

func aggregateFrom(bucketStart time.Time, samples []Sample) Aggregate {
	agg := Aggregate{BucketStart: bucketStart}
	if len(samples) == 0 {
		return agg
	}
	agg.CPUMin, agg.CPUMax = samples[0].CPUPercent, samples[0].CPUPercent
	agg.MemMin, agg.MemMax = samples[0].MemPercent, samples[0].MemPercent
	var cpuSum, memSum float64
	for _, s := range samples {
		cpuSum += s.CPUPercent
		memSum += s.MemPercent
		if s.CPUPercent < agg.CPUMin {
			agg.CPUMin = s.CPUPercent
		}
		if s.CPUPercent > agg.CPUMax {
			agg.CPUMax = s.CPUPercent
		}
		if s.MemPercent < agg.MemMin {
			agg.MemMin = s.MemPercent
		}
		if s.MemPercent > agg.MemMax {
			agg.MemMax = s.MemPercent
		}
	}
	agg.SampleCount = len(samples)
	agg.CPUAvg = cpuSum / float64(len(samples))
	agg.MemAvg = memSum / float64(len(samples))
	return agg
}

// Window liefert die Historie eines Hosts für die letzten `window`
// (auf [1m, 24h] geklammert). window <= rawWindow liefert Rohpunkte,
// darüber abgeschlossene 1-Minuten-Aggregate (der noch offene aktuelle
// Eimer ist bewusst nicht enthalten — er ist noch nicht min/avg/max-
// stabil). ok=false, wenn der Host noch nie eine Telemetrie gemeldet
// hat.
func (h *History) Window(hostID string, window time.Duration) (HistoryWindow, bool) {
	if window < time.Minute {
		window = time.Minute
	}
	if window > aggregateWindow {
		window = aggregateWindow
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	hh, ok := h.byHost[hostID]
	if !ok {
		return HistoryWindow{}, false
	}

	cutoff := time.Now().Add(-window)

	if window <= rawWindow {
		var samples []Sample
		for _, s := range hh.raw {
			if !s.Timestamp.Before(cutoff) {
				samples = append(samples, s)
			}
		}
		return HistoryWindow{
			Resolution: "raw",
			Samples:    samples,
			Summary:    summarizeSamples(samples),
		}, true
	}

	var aggregates []Aggregate
	for _, a := range hh.aggregates {
		if !a.BucketStart.Before(cutoff) {
			aggregates = append(aggregates, a)
		}
	}
	return HistoryWindow{
		Resolution: "aggregate",
		Aggregates: aggregates,
		Summary:    summarizeAggregates(aggregates),
	}, true
}

func summarizeSamples(samples []Sample) Summary {
	if len(samples) == 0 {
		return Summary{}
	}
	s := Summary{CPUMin: samples[0].CPUPercent, CPUMax: samples[0].CPUPercent, MemMin: samples[0].MemPercent, MemMax: samples[0].MemPercent}
	var cpuSum, memSum float64
	for _, p := range samples {
		cpuSum += p.CPUPercent
		memSum += p.MemPercent
		if p.CPUPercent < s.CPUMin {
			s.CPUMin = p.CPUPercent
		}
		if p.CPUPercent > s.CPUMax {
			s.CPUMax = p.CPUPercent
		}
		if p.MemPercent < s.MemMin {
			s.MemMin = p.MemPercent
		}
		if p.MemPercent > s.MemMax {
			s.MemMax = p.MemPercent
		}
	}
	s.SampleCount = len(samples)
	s.CPUAvg = cpuSum / float64(len(samples))
	s.MemAvg = memSum / float64(len(samples))
	return s
}

// summarizeAggregates kombiniert bereits verdichtete Buckets zu einer
// Gesamt-Summary — Ø wird über SampleCount gewichtet, damit ein Bucket
// mit weniger Samples (z. B. der erste nach Prozessstart) das
// Gesamtmittel nicht verzerrt wie ein einfacher Durchschnitt der
// Bucket-Mittelwerte es täte.
func summarizeAggregates(aggregates []Aggregate) Summary {
	if len(aggregates) == 0 {
		return Summary{}
	}
	s := Summary{CPUMin: aggregates[0].CPUMin, CPUMax: aggregates[0].CPUMax, MemMin: aggregates[0].MemMin, MemMax: aggregates[0].MemMax}
	var cpuWeighted, memWeighted float64
	var totalSamples int
	for _, a := range aggregates {
		if a.CPUMin < s.CPUMin {
			s.CPUMin = a.CPUMin
		}
		if a.CPUMax > s.CPUMax {
			s.CPUMax = a.CPUMax
		}
		if a.MemMin < s.MemMin {
			s.MemMin = a.MemMin
		}
		if a.MemMax > s.MemMax {
			s.MemMax = a.MemMax
		}
		cpuWeighted += a.CPUAvg * float64(a.SampleCount)
		memWeighted += a.MemAvg * float64(a.SampleCount)
		totalSamples += a.SampleCount
	}
	s.SampleCount = totalSamples
	if totalSamples > 0 {
		s.CPUAvg = cpuWeighted / float64(totalSamples)
		s.MemAvg = memWeighted / float64(totalSamples)
	}
	return s
}

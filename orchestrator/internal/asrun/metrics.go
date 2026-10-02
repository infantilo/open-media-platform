package asrun

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Histogramm-Grenzen in Sekunden (Verspätung/Vorzeitigkeit und Dauer).
var (
	latenessBuckets = []float64{0.04, 0.2, 1, 5, 30, 300}
	durationBuckets = []float64{5, 15, 30, 60, 300, 1800, 7200}
	latencyBuckets  = []float64{0.05, 0.25, 1, 5, 30}
)

type histogram struct {
	bounds []float64
	counts []uint64
	sum    float64
	n      uint64
}

func newHistogram(bounds []float64) *histogram {
	return &histogram{bounds: bounds, counts: make([]uint64, len(bounds))}
}

func (h *histogram) observe(v float64) {
	for i, b := range h.bounds {
		if v <= b {
			h.counts[i]++
		}
	}
	h.sum += v
	h.n++
}

// Metrics hält die Kennzahlen (Spec §192) je Channel im Speicher — wie jeder Prometheus-Zähler
// setzt ein Neustart sie zurück. Doppelte Lieferungen (at-least-once) zählen nur einmal.
type Metrics struct {
	mu       sync.Mutex
	counters map[string]uint64     // name{labels}
	hist     map[string]*histogram // name{channel}
	seen     map[string]struct{}
}

// NewMetrics erstellt leere Kennzahlen.
func NewMetrics() *Metrics {
	return &Metrics{counters: map[string]uint64{}, hist: map[string]*histogram{}, seen: map[string]struct{}{}}
}

func (m *Metrics) inc(name, labels string) { m.counters[name+"{"+labels+"}"]++ }

func (m *Metrics) observeHist(name, labels string, bounds []float64, v float64) {
	k := name + "{" + labels + "}"
	h, ok := m.hist[k]
	if !ok {
		h = newHistogram(bounds)
		m.hist[k] = h
	}
	h.observe(v)
}

// firstTime meldet true, wenn der Schlüssel noch nicht gezählt wurde.
func (m *Metrics) firstTime(key string) bool {
	if _, ok := m.seen[key]; ok {
		return false
	}
	if len(m.seen) > 20000 {
		m.seen = map[string]struct{}{}
	}
	m.seen[key] = struct{}{}
	return true
}

// Observe verbucht eine gelieferte Zeile.
func (m *Metrics) Observe(channel string, r Record) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ch := fmt.Sprintf(`channel=%q`, channel)
	switch r.Kind {
	case KindPrimary:
		if r.Status == StatusRunning {
			// Start-Verspätung/-Vorzeitigkeit zählt beim ersten Eintreffen des Starts.
			if r.ActualStart != nil && r.PlannedStart != nil && m.firstTime("start:"+channel+":"+r.Key) {
				d := r.ActualStart.Sub(*r.PlannedStart).Seconds()
				if d >= 0 {
					m.observeHist("omp_playout_event_start_lateness_seconds", ch, latenessBuckets, d)
				} else {
					m.observeHist("omp_playout_event_start_early_seconds", ch, latenessBuckets, -d)
				}
			}
			return
		}
		if !m.firstTime("end:" + channel + ":" + r.Key) {
			return
		}
		m.inc("omp_playout_events_total", ch+fmt.Sprintf(`,status=%q`, r.Status))
		if r.ActualStart != nil && r.ActualEnd != nil {
			m.observeHist("omp_playout_event_duration_seconds", ch, durationBuckets, r.ActualEnd.Sub(*r.ActualStart).Seconds())
		}
	case KindChild:
		if r.Status == "FAILED" && m.firstTime("child:"+channel+":"+r.Key+":"+r.Status) {
			m.inc("omp_playout_child_event_failures_total", ch)
		}
	case KindOperator:
		if m.firstTime("op:" + channel + ":" + r.Key) {
			m.inc("omp_playout_operator_actions_total", ch+fmt.Sprintf(`,action=%q`, r.Action))
		}
	case KindWarning:
		name := map[string]string{
			"source_resolution": "omp_playout_source_resolution_failures_total",
			"audio_resolution":  "omp_playout_audio_resolution_failures_total",
			"asset_preflight":   "omp_playout_asset_preflight_failures_total",
		}[r.Action]
		if name != "" && m.firstTime("warn:"+channel+":"+r.Key) {
			m.inc(name, ch)
		}
	}
}

// ObserveTriggerLatency verbucht die Zeit von „gesendet“ bis „quittiert“ eines Channel-Triggers.
func (m *Metrics) ObserveTriggerLatency(targetChannel string, seconds float64) {
	if m == nil || seconds < 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observeHist("omp_playout_channel_trigger_latency_seconds", fmt.Sprintf(`channel=%q`, targetChannel), latencyBuckets, seconds)
}

// WritePrometheus schreibt alle Kennzahlen im Textformat.
func (m *Metrics) WritePrometheus(b *strings.Builder) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	help := map[string]string{
		"omp_playout_events_total":                     "Primary events finished, by final status.",
		"omp_playout_child_event_failures_total":       "Child events that ended in FAILED.",
		"omp_playout_operator_actions_total":           "Manual operator interventions.",
		"omp_playout_source_resolution_failures_total": "Source resolutions that found no usable source.",
		"omp_playout_audio_resolution_failures_total":  "Audio resolutions with warnings or without a result.",
		"omp_playout_asset_preflight_failures_total":   "Assets that were not ready in time.",
		"omp_playout_event_start_lateness_seconds":     "How late a primary event started compared with its plan.",
		"omp_playout_event_start_early_seconds":        "How early a primary event started compared with its plan.",
		"omp_playout_event_duration_seconds":           "Actual duration of finished primary events.",
		"omp_playout_channel_trigger_latency_seconds":  "Time from sending a channel trigger to its acknowledgement.",
	}
	names := map[string]bool{}
	for k := range m.counters {
		names[k[:strings.Index(k, "{")]] = true
	}
	for k := range m.hist {
		names[k[:strings.Index(k, "{")]] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		isHist := false
		for k := range m.hist {
			if strings.HasPrefix(k, n+"{") {
				isHist = true
				break
			}
		}
		typ := "counter"
		if isHist {
			typ = "histogram"
		}
		fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s %s\n", n, help[n], n, typ)
		keys := []string{}
		src := m.counters
		if isHist {
			for k := range m.hist {
				if strings.HasPrefix(k, n+"{") {
					keys = append(keys, k)
				}
			}
		} else {
			for k := range src {
				if strings.HasPrefix(k, n+"{") {
					keys = append(keys, k)
				}
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			labels := k[strings.Index(k, "{")+1 : len(k)-1]
			if !isHist {
				fmt.Fprintf(b, "%s{%s} %d\n", n, labels, src[k])
				continue
			}
			h := m.hist[k]
			for i, bound := range h.bounds {
				fmt.Fprintf(b, "%s_bucket{%s,le=\"%s\"} %d\n", n, labels, trimFloat(bound), h.counts[i])
			}
			fmt.Fprintf(b, "%s_bucket{%s,le=\"+Inf\"} %d\n%s_sum{%s} %s\n%s_count{%s} %d\n", n, labels, h.n, n, labels, trimFloat(h.sum), n, labels, h.n)
		}
	}
}

func trimFloat(v float64) string {
	s := fmt.Sprintf("%f", v)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	if s == "" {
		return "0"
	}
	return s
}

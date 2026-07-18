// GET /metrics (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "/metrics
// im Prometheus-Textformat handgeschrieben — Minimal-Dependency-Regel §0
// Punkt 5, das Format ist trivial, kein Client-Library-Zwang"). Kein
// prometheus/client_golang, keine Registry-Abstraktion — die paar
// Kennzahlen werden bei jedem Scrape direkt aus den bereits vorhandenen
// Quellen gelesen (Registry-Store, SSE-Hub, Launcher, Go-Runtime, der
// Request-Zähler dieser Datei) und als Text geschrieben.
package httpapi

import (
	"fmt"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
)

// requestCounters zählt HTTP-Requests nach Status-Klasse, geteilt
// zwischen der zählenden Middleware (countRequests) und handleMetrics.
// Ein Zähler pro Prozess (in NewHandler erzeugt), keine Persistenz —
// ein Neustart setzt ihn zurück, wie bei jedem Prometheus-Counter
// üblich (der Scraper erkennt das am Wertesprung nach unten).
type requestCounters struct {
	status2xx atomic.Uint64
	status3xx atomic.Uint64
	status4xx atomic.Uint64
	status5xx atomic.Uint64
}

func (c *requestCounters) record(status int) {
	switch {
	case status < 300:
		c.status2xx.Add(1)
	case status < 400:
		c.status3xx.Add(1)
	case status < 500:
		c.status4xx.Add(1)
	default:
		c.status5xx.Add(1)
	}
}

// countRequests umschließt den gesamten Mux (s. NewHandler) — zählt
// jeden Request unabhängig von Route/Auth-Ausgang, auch 404s und von
// authGate abgelehnte Requests.
func countRequests(counters *requestCounters, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		counters.record(rec.status)
	})
}

// handleMetrics liefert alle Kennzahlen aus §S8: Go-Runtime (Goroutinen,
// Heap, GC), Registry (Nodes online/gesamt, Poll-Dauer), SSE
// (Clients+Drops), Launcher (Instanzen, Neustarts), HTTP-Request-Zähler.
func handleMetrics(nodes NodeLister, events EventSubscriber, launcherSvc LauncherService, counters *requestCounters) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b strings.Builder
		writeGoRuntimeMetrics(&b)
		writeRegistryMetrics(&b, nodes)
		writeSSEMetrics(&b, events)
		writeLauncherMetrics(&b, launcherSvc)
		writeHTTPMetrics(&b, counters)

		// text/plain mit expliziter Prometheus-Exposition-Format-Version
		// (offizieller Content-Type, s. Prometheus-Doku "Exposition
		// Formats") — kein Client wertet das im Dev-Betrieb streng aus,
		// aber ein echter Scraper erwartet ihn.
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(b.String()))
	}
}

// formatValue vermeidet bewusst Gos "%v"-Default-Formatierung für
// float64: die wechselt ab einer gewissen Größe (z. B. Heap-Bytes im
// niedrigen Megabyte-Bereich, per Testlauf gefunden: "8.02816e+06")
// stillschweigend in wissenschaftliche Notation — technisch gültiges
// Prometheus-Format, aber unnötig schwer lesbar und ein
// Überraschungsrisiko für die eigene Formatprüfung im Test (die
// "well-formed"-Bedingung ohne promtool). 'f'-Notation mit
// Minimalpräzision (-1) bleibt immer eine schlichte Dezimalzahl.
func formatValue(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func writeMetric(b *strings.Builder, name, help, typ string, value float64, labels string) {
	fmt.Fprintf(b, "# HELP %s %s\n", name, help)
	fmt.Fprintf(b, "# TYPE %s %s\n", name, typ)
	if labels == "" {
		fmt.Fprintf(b, "%s %s\n", name, formatValue(value))
	} else {
		fmt.Fprintf(b, "%s{%s} %s\n", name, labels, formatValue(value))
	}
}

func writeGoRuntimeMetrics(b *strings.Builder) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	writeMetric(b, "omp_go_goroutines", "Number of goroutines that currently exist.", "gauge", float64(runtime.NumGoroutine()), "")
	writeMetric(b, "omp_go_heap_alloc_bytes", "Bytes of allocated heap objects currently in use.", "gauge", float64(m.HeapAlloc), "")
	writeMetric(b, "omp_go_heap_sys_bytes", "Bytes of heap memory obtained from the OS.", "gauge", float64(m.HeapSys), "")
	writeMetric(b, "omp_go_gc_runs_total", "Number of completed garbage collection cycles since process start.", "counter", float64(m.NumGC), "")
	writeMetric(b, "omp_go_gc_pause_seconds_total", "Cumulative time spent in garbage collection pauses since process start.", "counter", float64(m.PauseTotalNs)/1e9, "")
}

func writeRegistryMetrics(b *strings.Builder, nodes NodeLister) {
	list := nodes.List()
	online := 0
	for _, n := range list {
		if n.Online {
			online++
		}
	}
	writeMetric(b, "omp_registry_nodes", "Number of nodes currently known to the registry poll.", "gauge", float64(len(list)), "")
	writeMetric(b, "omp_registry_nodes_online", "Number of currently known nodes considered online.", "gauge", float64(online), "")
	writeMetric(b, "omp_registry_poll_duration_seconds", "Duration of the most recently completed registry poll.", "gauge", nodes.PollDuration().Seconds(), "")
}

func writeSSEMetrics(b *strings.Builder, events EventSubscriber) {
	writeMetric(b, "omp_sse_clients", "Number of currently connected SSE clients.", "gauge", float64(events.ClientCount()), "")
	writeMetric(b, "omp_sse_dropped_events_total", "Cumulative number of SSE events that failed delivery to a slow client since process start.", "counter", float64(events.TotalDrops()), "")
}

func writeLauncherMetrics(b *strings.Builder, launcherSvc LauncherService) {
	writeMetric(b, "omp_launcher_instances", "Number of node instances currently tracked by the launcher.", "gauge", float64(len(launcherSvc.List())), "")
	writeMetric(b, "omp_launcher_restarts_total", "Cumulative number of automatic instance restarts since process start.", "counter", float64(launcherSvc.TotalRestarts()), "")
}

func writeHTTPMetrics(b *strings.Builder, counters *requestCounters) {
	fmt.Fprintf(b, "# HELP omp_http_requests_total Total HTTP requests handled, by response status class.\n")
	fmt.Fprintf(b, "# TYPE omp_http_requests_total counter\n")
	fmt.Fprintf(b, "omp_http_requests_total{status=\"2xx\"} %d\n", counters.status2xx.Load())
	fmt.Fprintf(b, "omp_http_requests_total{status=\"3xx\"} %d\n", counters.status3xx.Load())
	fmt.Fprintf(b, "omp_http_requests_total{status=\"4xx\"} %d\n", counters.status4xx.Load())
	fmt.Fprintf(b, "omp_http_requests_total{status=\"5xx\"} %d\n", counters.status5xx.Load())
}

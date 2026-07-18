package httpapi

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// metricLineRE prüft die Prometheus-Text-Exposition-Grundform einer
// Nicht-Kommentar-Zeile: "name{label=\"value\",...}? value" (S8,
// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "curl /metrics well-formed
// … sonst Formatprüfung im Test" — kein promtool auf dieser Dev-Maschine
// installiert, s. docs/decisions.md).
var metricLineRE = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? -?[0-9]+(\.[0-9]+)?$`)

func TestHandleMetricsWellFormed(t *testing.T) {
	nodes := fakeNodeLister{
		nodes: []registry.NodeView{
			{ID: "n1", Online: true},
			{ID: "n2", Online: false},
		},
		pollDuration: 15 * time.Millisecond,
	}
	events := fakeEventSubscriber{clientCount: 3, totalDrops: 7}
	launcherSvc := fakeLauncherService{
		instances:     []launcher.Instance{{ID: "i1"}, {ID: "i2"}},
		totalRestarts: 5,
	}
	counters := &requestCounters{}
	counters.record(200)
	counters.record(404)
	counters.record(500)

	h := handleMetrics(nodes, events, launcherSvc, counters)
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain prefix", ct)
	}

	body := rec.Body.String()
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")

	seenHelp := map[string]bool{}
	seenType := map[string]bool{}
	metricNames := map[string]bool{}

	for i, line := range lines {
		switch {
		case strings.HasPrefix(line, "# HELP "):
			name := strings.Fields(strings.TrimPrefix(line, "# HELP "))[0]
			seenHelp[name] = true
		case strings.HasPrefix(line, "# TYPE "):
			fields := strings.Fields(strings.TrimPrefix(line, "# TYPE "))
			if len(fields) != 2 || (fields[1] != "gauge" && fields[1] != "counter") {
				t.Errorf("line %d: malformed TYPE line %q", i, line)
				continue
			}
			seenType[fields[0]] = true
		case line == "":
			continue
		default:
			if !metricLineRE.MatchString(line) {
				t.Errorf("line %d: does not match Prometheus exposition format: %q", i, line)
				continue
			}
			name := line[:strings.IndexAny(line, "{ ")]
			metricNames[name] = true
			if !seenHelp[name] {
				t.Errorf("line %d: metric %q has a sample but no preceding HELP line", i, name)
			}
			if !seenType[name] {
				t.Errorf("line %d: metric %q has a sample but no preceding TYPE line", i, name)
			}
		}
	}

	// Jede HELP/TYPE-Zeile sollte auch mindestens eine Sample-Zeile haben
	// (kein verwaister Header) — Kehrseite der Schleife oben.
	for name := range seenHelp {
		if !metricNames[name] {
			t.Errorf("metric %q has HELP/TYPE but no sample line", name)
		}
	}

	// Stichprobenartig echte Werte prüfen, nicht nur das Format — s.
	// requireValue-Helfer unten.
	requireValue(t, body, "omp_registry_nodes", "2")
	requireValue(t, body, "omp_registry_nodes_online", "1")
	requireValue(t, body, "omp_registry_poll_duration_seconds", "0.015")
	requireValue(t, body, "omp_sse_clients", "3")
	requireValue(t, body, "omp_sse_dropped_events_total", "7")
	requireValue(t, body, "omp_launcher_instances", "2")
	requireValue(t, body, "omp_launcher_restarts_total", "5")
	requireLabeledValue(t, body, "omp_http_requests_total", `status="2xx"`, "1")
	requireLabeledValue(t, body, "omp_http_requests_total", `status="4xx"`, "1")
	requireLabeledValue(t, body, "omp_http_requests_total", `status="5xx"`, "1")
}

func requireValue(t *testing.T, body, name, want string) {
	t.Helper()
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, name+" ") {
			got := strings.TrimSpace(strings.TrimPrefix(line, name+" "))
			if got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
			return
		}
	}
	t.Errorf("metric %q not found in output", name)
}

func requireLabeledValue(t *testing.T, body, name, labels, want string) {
	t.Helper()
	prefix := name + "{" + labels + "}"
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, prefix+" ") {
			got := strings.TrimSpace(strings.TrimPrefix(line, prefix+" "))
			if got != want {
				t.Errorf("%s = %q, want %q", prefix, got, want)
			}
			return
		}
	}
	t.Errorf("metric %q not found in output", prefix)
}

// TestCountRequestsRecordsStatusClass prüft, dass die zählende
// Middleware den tatsächlich geschriebenen Status erfasst, nicht nur
// den impliziten 200-Default.
func TestCountRequestsRecordsStatusClass(t *testing.T) {
	counters := &requestCounters{}
	h := countRequests(counters, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := counters.status4xx.Load(); got != 1 {
		t.Errorf("status4xx = %d, want 1 (418 Teapot)", got)
	}
	if got := counters.status2xx.Load(); got != 0 {
		t.Errorf("status2xx = %d, want 0", got)
	}
}

// TestCountRequestsDoesNotBreakFlushing verifiziert, wovon
// TestHandleEventsStreamsBroadcastEvents (server_test.go) beim
// Einführen dieser Middleware live betroffen war: ein hinter
// countRequests gewickelter Handler muss weiterhin per
// http.Flusher.Flush() streamen können (SSE), s.
// statusRecorder.Flush() in auth_middleware.go.
func TestCountRequestsDoesNotBreakFlushing(t *testing.T) {
	counters := &requestCounters{}
	h := countRequests(counters, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("ResponseWriter behind countRequests does not implement http.Flusher")
		}
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
}


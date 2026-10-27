package httpapi

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
)

// defaultLogLimit/maxLogLimit — gleiches Muster wie
// defaultAuditLogLimit/maxAuditLogLimit (auth_handlers.go).
const (
	defaultLogLimit = 100
	maxLogLimit     = 500
)

// LogReader liest die zentrale Log-Projektion (ARCHITECTURE.md §25.2,
// UMSETZUNG.md D19 — implementiert von *logbus.Store).
type LogReader interface {
	Query(f logbus.Filter) ([]logbus.Entry, error)
}

// LogSummarizer ist die optionale Erweiterung um gruppierte Meldungen
// (implementiert von *logbus.Store).
type LogSummarizer interface {
	Summary(f logbus.Filter, limit int) ([]logbus.Group, error)
}

// logFilterFromQuery liest die gemeinsamen Filter-Parameter:
// traceId, nodeId, hostId, level (auch kommagetrennt), q, since, until, msgKey.
func logFilterFromQuery(q url.Values) logbus.Filter {
	f := logbus.Filter{
		TraceID: q.Get("traceId"),
		NodeID:  q.Get("nodeId"),
		HostID:  q.Get("hostId"),
		Query:   q.Get("q"),
		MsgKey:  q.Get("msgKey"),
	}
	if lv := q.Get("level"); strings.Contains(lv, ",") {
		f.Levels = strings.Split(lv, ",")
	} else {
		f.Level = lv
	}
	if v, err := time.Parse(time.RFC3339, q.Get("since")); err == nil {
		f.Since = v
	}
	if v, err := time.Parse(time.RFC3339, q.Get("until")); err == nil {
		f.Until = v
	}
	return f
}

// handleLogSummary liefert GET /api/v1/logs/summary — gleichartige Meldungen
// gruppiert (Anzahl, erstes/letztes Auftreten, betroffene Nodes).
func handleLogSummary(reader LogReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sum, ok := reader.(LogSummarizer)
		if !ok {
			http.Error(w, "summary not supported", http.StatusNotImplemented)
			return
		}
		groups, err := sum.Summary(logFilterFromQuery(r.URL.Query()), 100)
		if err != nil {
			http.Error(w, "failed to summarize logs", http.StatusInternalServerError)
			return
		}
		for i := range groups {
			if e, ok := errcodes.Classify(groups[i].Example); ok {
				groups[i].Code = e.Code
			}
		}
		writeJSON(w, http.StatusOK, groups)
	}
}

// handleListLogs liefert GET /api/v1/logs — admin-only (gleiches Gate
// wie das Audit-Log, §12 Punkt 4), da Log-Zeilen node-/host-
// übergreifend Betriebsdetails offenlegen. Filter (alle optional):
// ?traceId=&nodeId=&hostId=&level=&before=&limit= — der Trace-Filter
// ist die eigentliche Anforderung aus §25.3 ("Trace-Waterfall": alles
// zu einer trace_id, hostübergreifend, an einem Ort).
func handleListLogs(reader LogReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		var before int64
		if v := q.Get("before"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 {
				before = parsed
			}
		}
		limit := defaultLogLimit
		if v := q.Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > maxLogLimit {
			limit = maxLogLimit
		}

		f := logFilterFromQuery(q)
		f.Before, f.Limit = before, limit
		entries, err := reader.Query(f)
		if err != nil {
			http.Error(w, "failed to query logs", http.StatusInternalServerError)
			return
		}
		for i := range entries {
			if e, ok := errcodes.Classify(entries[i].Message); ok {
				entries[i].Code = e.Code
			}
		}
		writeJSON(w, http.StatusOK, entries)
	}
}

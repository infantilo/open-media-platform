package httpapi

import (
	"net/http"
	"strconv"

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

		entries, err := reader.Query(logbus.Filter{
			TraceID: q.Get("traceId"),
			NodeID:  q.Get("nodeId"),
			HostID:  q.Get("hostId"),
			Level:   q.Get("level"),
			Before:  before,
			Limit:   limit,
		})
		if err != nil {
			http.Error(w, "failed to query logs", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}

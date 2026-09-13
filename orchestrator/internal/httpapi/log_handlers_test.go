package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
)

// fakeLogReader — gleiches Test-Double-Muster wie fakeAuditSvc
// (auth_handlers_test.go): erfasst den zuletzt übergebenen Filter.
type fakeLogReader struct {
	lastFilter logbus.Filter
	entries    []logbus.Entry
}

func (f *fakeLogReader) Query(filter logbus.Filter) ([]logbus.Entry, error) {
	f.lastFilter = filter
	return f.entries, nil
}

func TestHandleListLogsDefaultsWithoutQueryParams(t *testing.T) {
	reader := &fakeLogReader{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs", nil)
	rec := httptest.NewRecorder()
	handleListLogs(reader)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if reader.lastFilter.Limit != defaultLogLimit {
		t.Errorf("Query() called with Limit=%d, want default %d", reader.lastFilter.Limit, defaultLogLimit)
	}
	if reader.lastFilter.TraceID != "" || reader.lastFilter.NodeID != "" {
		t.Errorf("Query() filter = %+v, want empty TraceID/NodeID by default", reader.lastFilter)
	}
}

func TestHandleListLogsParsesTraceIDFilter(t *testing.T) {
	reader := &fakeLogReader{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?traceId=abc123&nodeId=node-1&hostId=host-1&level=warn&before=42&limit=10", nil)
	rec := httptest.NewRecorder()
	handleListLogs(reader)(rec, req)

	want := logbus.Filter{TraceID: "abc123", NodeID: "node-1", HostID: "host-1", Level: "warn", Before: 42, Limit: 10}
	if reader.lastFilter != want {
		t.Errorf("Query() filter = %+v, want %+v", reader.lastFilter, want)
	}
}

func TestHandleListLogsCapsLimitAtMax(t *testing.T) {
	reader := &fakeLogReader{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?limit=999999", nil)
	rec := httptest.NewRecorder()
	handleListLogs(reader)(rec, req)

	if reader.lastFilter.Limit != maxLogLimit {
		t.Errorf("Query() called with Limit=%d, want capped at %d", reader.lastFilter.Limit, maxLogLimit)
	}
}

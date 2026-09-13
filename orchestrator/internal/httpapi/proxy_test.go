package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// fakeNodeCallLogger — Test-Double für NodeCallLogger.
type fakeNodeCallLogger struct {
	entries []logbus.Entry
}

func (f *fakeNodeCallLogger) Publish(ctx context.Context, e logbus.Entry) {
	f.entries = append(f.entries, e)
}

func TestHandleNodeProxySetsTraceHeaderAndForwardsIt(t *testing.T) {
	var gotTrace string
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace = r.Header.Get(tracing.HeaderTraceID)
		w.WriteHeader(http.StatusOK)
	}))
	defer nodeServer.Close()

	nodes := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/descriptor", nil)
	req.SetPathValue("id", "node-1")
	rec := httptest.NewRecorder()
	handleNodeProxy(nodes, nil, "/descriptor.json", nil)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	respTrace := rec.Header().Get(tracing.HeaderTraceID)
	if respTrace == "" {
		t.Fatal("response has no trace id header")
	}
	if gotTrace != respTrace {
		t.Errorf("node received trace %q, response carries %q — must be the same trace", gotTrace, respTrace)
	}
}

// TestHandleNodeProxyLogsFailure closes a real, previously-existing gap
// (ARCHITECTURE.md §25.2, UMSETZUNG.md D19): a failed node proxy call
// used to be visible only as an HTTP error to the browser, with nothing
// logged server-side.
func TestHandleNodeProxyLogsFailure(t *testing.T) {
	nodes := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: "http://127.0.0.1:1"}}}
	logs := &fakeNodeCallLogger{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/descriptor", nil)
	req.SetPathValue("id", "node-1")
	rec := httptest.NewRecorder()
	handleNodeProxy(nodes, nil, "/descriptor.json", logs)(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (node unreachable)", rec.Code)
	}
	if len(logs.entries) != 1 {
		t.Fatalf("logs.entries = %+v, want exactly one published entry", logs.entries)
	}
	if logs.entries[0].NodeID != "node-1" {
		t.Errorf("NodeID = %q, want %q", logs.entries[0].NodeID, "node-1")
	}
	if logs.entries[0].Level != "error" {
		t.Errorf("Level = %q, want %q", logs.entries[0].Level, "error")
	}
}

func TestHandleNodeProxyDoesNotLogOnUnknownNode(t *testing.T) {
	nodes := fakeNodeLister{}
	logs := &fakeNodeCallLogger{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/missing/descriptor", nil)
	req.SetPathValue("id", "missing")
	rec := httptest.NewRecorder()
	handleNodeProxy(nodes, nil, "/descriptor.json", logs)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if len(logs.entries) != 0 {
		t.Errorf("logs.entries = %+v, want none (unknown node is a client error, not an operational failure)", logs.entries)
	}
}

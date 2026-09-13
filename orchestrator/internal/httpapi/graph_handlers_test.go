package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// ARCHITECTURE.md §25.1 (UMSETZUNG.md D19): a graph edge request must
// always carry back a trace id header, on success and on failure, so an
// admin can look up what happened in the central log channel (§25.2/
// §25.3) without changing the existing plain-text error body format.

func TestHandlePostGraphEdgeSetsTraceHeaderOnSuccess(t *testing.T) {
	svc := &fakeGraphService{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", bytes.NewBufferString(`{"from":"send-1","to":"recv-1"}`))
	rec := httptest.NewRecorder()
	handlePostGraphEdge(svc)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Header().Get(tracing.HeaderTraceID) == "" {
		t.Error("response has no trace id header on success")
	}
}

func TestHandlePostGraphEdgeSetsTraceHeaderOnFailure(t *testing.T) {
	svc := &fakeGraphService{connectErr: graph.ErrUnknownReceiver}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", bytes.NewBufferString(`{"from":"send-1","to":"recv-1"}`))
	rec := httptest.NewRecorder()
	handlePostGraphEdge(svc)(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("status = %d, want a non-200 error status", rec.Code)
	}
	if rec.Header().Get(tracing.HeaderTraceID) == "" {
		t.Error("response has no trace id header on failure — this is exactly the case an admin needs to correlate")
	}
}

func TestHandleDeleteGraphEdgeSetsTraceHeader(t *testing.T) {
	svc := &fakeGraphService{}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/graph/edges/recv-1", nil)
	req.SetPathValue("id", "recv-1")
	rec := httptest.NewRecorder()
	handleDeleteGraphEdge(svc)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Header().Get(tracing.HeaderTraceID) == "" {
		t.Error("response has no trace id header")
	}
}

func TestHandlePostGraphEdgeReusesIncomingTraceHeader(t *testing.T) {
	svc := &fakeGraphService{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", bytes.NewBufferString(`{"from":"send-1","to":"recv-1"}`))
	req.Header.Set(tracing.HeaderTraceID, "caller-supplied-trace")
	rec := httptest.NewRecorder()
	handlePostGraphEdge(svc)(rec, req)

	if got := rec.Header().Get(tracing.HeaderTraceID); got != "caller-supplied-trace" {
		t.Errorf("trace header = %q, want the caller-supplied %q to be reused, not overwritten", got, "caller-supplied-trace")
	}
}

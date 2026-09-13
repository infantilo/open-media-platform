package is05

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

func TestPatchStagedPropagatesTraceHeaders(t *testing.T) {
	var gotTrace, gotSpan string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace = r.Header.Get(tracing.HeaderTraceID)
		gotSpan = r.Header.Get(tracing.HeaderSpanID)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ctx := tracing.WithTrace(context.Background(), "trace-1", "span-1")
	c := NewClient(nil)
	senderID := "sender-1"
	if err := c.PatchStaged(ctx, server.URL, "receiver-1", &senderID, true); err != nil {
		t.Fatalf("PatchStaged() error = %v", err)
	}

	if gotTrace != "trace-1" {
		t.Errorf("%s header = %q, want %q", tracing.HeaderTraceID, gotTrace, "trace-1")
	}
	if gotSpan != "span-1" {
		t.Errorf("%s header = %q, want %q", tracing.HeaderSpanID, gotSpan, "span-1")
	}
}

func TestPatchStagedGeneratesTraceWhenContextHasNone(t *testing.T) {
	var gotTrace string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace = r.Header.Get(tracing.HeaderTraceID)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewClient(nil)
	if err := c.PatchStaged(context.Background(), server.URL, "receiver-1", nil, false); err != nil {
		t.Fatalf("PatchStaged() error = %v", err)
	}
	if gotTrace == "" {
		t.Error("expected a generated trace id header even without a context trace")
	}
}

func TestGetActivePropagatesTraceHeaders(t *testing.T) {
	var gotTrace string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace = r.Header.Get(tracing.HeaderTraceID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"sender_id":null,"master_enable":false}`))
	}))
	defer server.Close()

	ctx := tracing.WithTrace(context.Background(), "trace-2", "span-2")
	c := NewClient(nil)
	if _, err := c.GetActive(ctx, server.URL, "receiver-1"); err != nil {
		t.Fatalf("GetActive() error = %v", err)
	}
	if gotTrace != "trace-2" {
		t.Errorf("%s header = %q, want %q", tracing.HeaderTraceID, gotTrace, "trace-2")
	}
}

func TestPatchSenderStagedPropagatesTraceHeaders(t *testing.T) {
	var gotTrace string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTrace = r.Header.Get(tracing.HeaderTraceID)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ctx := tracing.WithTrace(context.Background(), "trace-3", "span-3")
	c := NewClient(nil)
	if err := c.PatchSenderStaged(ctx, server.URL, "sender-1", true); err != nil {
		t.Fatalf("PatchSenderStaged() error = %v", err)
	}
	if gotTrace != "trace-3" {
		t.Errorf("%s header = %q, want %q", tracing.HeaderTraceID, gotTrace, "trace-3")
	}
}

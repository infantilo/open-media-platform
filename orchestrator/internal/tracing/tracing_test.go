package tracing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEnsureStartsNewTraceOnEmptyContext(t *testing.T) {
	ctx := Ensure(context.Background())
	if TraceID(ctx) == "" {
		t.Error("TraceID(ctx) = \"\", want a generated trace id")
	}
	if SpanID(ctx) == "" {
		t.Error("SpanID(ctx) = \"\", want a generated span id")
	}
}

func TestEnsureKeepsExistingTrace(t *testing.T) {
	ctx := WithTrace(context.Background(), "trace-1", "span-1")
	ctx = Ensure(ctx)
	if TraceID(ctx) != "trace-1" {
		t.Errorf("TraceID(ctx) = %q, want %q (Ensure must not overwrite an existing trace)", TraceID(ctx), "trace-1")
	}
}

func TestNewSpanKeepsTraceButChangesSpan(t *testing.T) {
	ctx := WithTrace(context.Background(), "trace-1", "span-1")
	ctx = NewSpan(ctx)
	if TraceID(ctx) != "trace-1" {
		t.Errorf("TraceID(ctx) = %q, want unchanged %q", TraceID(ctx), "trace-1")
	}
	if SpanID(ctx) == "span-1" {
		t.Error("SpanID(ctx) unchanged, want a fresh span id under the same trace")
	}
}

func TestNewSpanStartsTraceIfMissing(t *testing.T) {
	ctx := NewSpan(context.Background())
	if TraceID(ctx) == "" {
		t.Error("TraceID(ctx) = \"\", want NewSpan to start a trace when none exists")
	}
}

func TestSetHeadersWritesTraceAndSpan(t *testing.T) {
	ctx := WithTrace(context.Background(), "trace-1", "span-1")
	req := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	SetHeaders(req, ctx)
	if got := req.Header.Get(HeaderTraceID); got != "trace-1" {
		t.Errorf("%s = %q, want %q", HeaderTraceID, got, "trace-1")
	}
	if got := req.Header.Get(HeaderSpanID); got != "span-1" {
		t.Errorf("%s = %q, want %q", HeaderSpanID, got, "span-1")
	}
}

func TestSetHeadersGeneratesTraceWhenContextHasNone(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	SetHeaders(req, context.Background())
	if req.Header.Get(HeaderTraceID) == "" {
		t.Error("expected a generated trace id header even without a prior context trace")
	}
}

func TestFromRequestReusesIncomingHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	req.Header.Set(HeaderTraceID, "upstream-trace")
	req.Header.Set(HeaderSpanID, "upstream-span")
	ctx := FromRequest(req)
	if TraceID(ctx) != "upstream-trace" {
		t.Errorf("TraceID(ctx) = %q, want %q", TraceID(ctx), "upstream-trace")
	}
	if SpanID(ctx) != "upstream-span" {
		t.Errorf("SpanID(ctx) = %q, want %q", SpanID(ctx), "upstream-span")
	}
}

func TestFromRequestGeneratesTraceWithoutIncomingHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	ctx := FromRequest(req)
	if TraceID(ctx) == "" {
		t.Error("expected a generated trace id when the request carries none")
	}
}

func TestNewIDsAreUnique(t *testing.T) {
	a, b := NewID(), NewID()
	if a == b {
		t.Errorf("NewID() returned the same value twice: %q", a)
	}
	if len(a) != 32 {
		t.Errorf("NewID() length = %d, want 32 (16 bytes hex-encoded)", len(a))
	}
}

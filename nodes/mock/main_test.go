package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// D9 (UMSETZUNG.md): live am echten AMWA-IS-05-01-Tool-Lauf gefunden —
// ohne den Header schlugen elf Tests mit "'Access-Control-Allow-Origin'
// not in CORS headers" fehl (docs/decisions.md).
func TestWithCORSSetsHeaderOnEveryResponse(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})

	rec := httptest.NewRecorder()
	withCORS(inner).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/anything", nil))

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, "*")
	}
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want inner handler's %d (CORS wrapper must not swallow it)", rec.Code, http.StatusTeapot)
	}
}

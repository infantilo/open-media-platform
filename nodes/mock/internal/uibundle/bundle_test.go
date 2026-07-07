package uibundle

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerServesManifestAndBundle(t *testing.T) {
	h := Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ui/manifest.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("manifest status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "omp-mock-panel") {
		t.Fatalf("manifest body = %q, want to contain tag name", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ui/bundle.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("bundle status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "customElements.define") {
		t.Fatalf("bundle body = %q, want to contain customElements.define", rec.Body.String())
	}
}

func TestHandlerUnknownPathReturns404(t *testing.T) {
	h := Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ui/nope.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

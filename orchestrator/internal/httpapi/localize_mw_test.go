package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLocalizeEnglish(t *testing.T) {
	h := localizeEnglish(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"reason":"Ausweichhost gewählt (Affinitäts-Gruppe \"a\" bereits auf diesem Host)","n":1}`))
			return
		}
		if r.URL.Path == "/api/v1/q" {
			http.Error(w, "keine Quittung vom Ziel-Channel", http.StatusBadGateway)
			return
		}
		http.Error(w, "Bestätigung erforderlich (confirm: true)", http.StatusBadRequest)
	}))
	do := func(path, lang string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if lang != "" {
			req.Header.Set("Accept-Language", lang)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if r := do("/api/v1/x", "en"); r.Code != 400 || !strings.Contains(r.Body.String(), "Confirmation required") {
		t.Fatalf("en: %d %q", r.Code, r.Body.String())
	}
	if r := do("/api/v1/x", ""); !strings.Contains(r.Body.String(), "Bestätigung erforderlich") {
		t.Fatalf("de bleibt deutsch: %q", r.Body.String())
	}
	if r := do("/api/v1/q", "en"); !strings.Contains(r.Body.String(), "no acknowledgement from the target channel") {
		t.Fatalf("Quittung: %q", r.Body.String())
	}
	r := do("/api/v1/json", "en")
	if !strings.Contains(r.Body.String(), "Fallback host chosen (affinity group") || !strings.Contains(r.Body.String(), `"n":1`) {
		t.Fatalf("json: %q", r.Body.String())
	}
}

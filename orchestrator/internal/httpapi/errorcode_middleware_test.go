package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestErrorCodeHeaderOnlyOnFailures(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/ok", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "fine") })
	mux.HandleFunc("GET /api/v1/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: 1\n\n")
		w.(http.Flusher).Flush()
	})
	mux.HandleFunc("GET /api/v1/nodefail", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `node proxy call failed (GET /params/x): dial tcp 127.0.0.1:1: connect: connection refused`, http.StatusBadGateway)
	})
	mux.HandleFunc("GET /api/v1/denied", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unauthorized", http.StatusUnauthorized) })
	mux.HandleFunc("GET /api/v1/forbidden", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusForbidden) })
	mux.HandleFunc("GET /api/v1/unknown", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "etwas ganz anderes", http.StatusBadRequest)
	})
	mux.HandleFunc("GET /api/v1/tagged", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "[OMP-3005] kamera weg", http.StatusInternalServerError)
	})
	mux.HandleFunc("GET /ui/page", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unauthorized", http.StatusUnauthorized) })
	h := errorCodeHeader(mux)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	for path, want := range map[string]string{
		"/api/v1/nodefail":  "OMP-2001",
		"/api/v1/denied":    "OMP-6001",
		"/api/v1/forbidden": "OMP-6002",
		"/api/v1/tagged":    "OMP-3005",
		"/api/v1/unknown":   "",
		"/api/v1/ok":        "",
		"/ui/page":          "", // außerhalb von /api/ unangetastet
	} {
		rec := get(path)
		if got := rec.Header().Get(ErrorCodeHeader); got != want {
			t.Errorf("%s: %q, erwartet %q", path, got, want)
		}
	}
	// Status und Text bleiben unverändert
	rec := get("/api/v1/nodefail")
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "node proxy call failed") {
		t.Errorf("Antwort verändert: %d %q", rec.Code, rec.Body.String())
	}
	if rec := get("/api/v1/forbidden"); rec.Code != http.StatusForbidden {
		t.Errorf("Status ohne Text: %d", rec.Code)
	}
	// Erfolgsantworten und Ströme laufen unverändert und unverzögert durch (Flush erreicht den Client)
	if rec := get("/api/v1/ok"); rec.Code != 200 || rec.Body.String() != "fine" {
		t.Errorf("Erfolg: %d %q", rec.Code, rec.Body.String())
	}
	if rec := get("/api/v1/stream"); !rec.Flushed || rec.Body.String() != "data: 1\n\n" {
		t.Errorf("Strom: flushed=%v %q", rec.Flushed, rec.Body.String())
	}
}

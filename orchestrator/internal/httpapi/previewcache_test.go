package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Viele Betrachter derselben Vorschau loesen nur wenige Node-Abrufe aus; Parameter-URL wird gemerkt.
func TestStreamProxySharesImageFrames(t *testing.T) {
	var params, frames atomic.Int32
	var base string
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/params/previewUrl" {
			params.Add(1)
			fmt.Fprintf(w, `{"value":"%s/preview"}`, base)
			return
		}
		frames.Add(1)
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("JPEGDATA"))
	}))
	defer node.Close()
	base = node.URL
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/nodes/{id}/stream/{name}", handleNodeStreamProxy(fakeNodeLister{nodes: []registry.NodeView{{ID: "n1", APIBaseURL: node.URL}}}, nil))
	// Erste Anfrage lernt, dass der Stream Einzelbilder liefert (davor gibt es kein Teilen).
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/stream/previewUrl", nil))
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/stream/previewUrl", nil))
			if rec.Code != 200 || rec.Body.String() != "JPEGDATA" || rec.Header().Get("Content-Type") != "image/jpeg" {
				t.Errorf("status %d body %q", rec.Code, rec.Body.String())
			}
		}()
	}
	wg.Wait()
	if p := params.Load(); p > 3 {
		t.Errorf("Parameter-URL %d-mal abgerufen, erwartet <= 3", p)
	}
	if f := frames.Load(); f > 10 {
		t.Errorf("Bild %d-mal vom Node geholt, erwartet deutlich weniger als 50", f)
	}
}

// Nicht-Bild-Antworten (Dauerstrom) werden nie geteilt.
func TestStreamProxyDoesNotShareNonImage(t *testing.T) {
	var hits atomic.Int32
	var base string
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/params/levelsUrl" {
			fmt.Fprintf(w, `{"value":"%s/levels"}`, base)
			return
		}
		hits.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: 1\n\n")
	}))
	defer node.Close()
	base = node.URL
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/nodes/{id}/stream/{name}", handleNodeStreamProxy(fakeNodeLister{nodes: []registry.NodeView{{ID: "n1", APIBaseURL: node.URL}}}, nil))
	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/stream/levelsUrl", nil))
		if rec.Body.String() != "data: 1\n\n" {
			t.Fatalf("body %q", rec.Body.String())
		}
	}
	if hits.Load() != 5 {
		t.Errorf("Dauerstrom %d-mal geholt, erwartet 5", hits.Load())
	}
}

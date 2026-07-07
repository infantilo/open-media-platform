package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
)

func TestHandleHealthz(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %q, want %q", body["status"], "ok")
	}
}

func TestHandleInfo(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/info", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body InfoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body.Name != AppName {
		t.Errorf("name = %q, want %q", body.Name, AppName)
	}
	if body.Version == "" {
		t.Error("version should not be empty")
	}
}

func TestStaticUIServing(t *testing.T) {
	dir := t.TempDir()
	const html = "<html><body>OpenMediaPlatform UI-Platzhalter</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}

	h := NewHandler(config.Config{UIDir: dir})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
		t.Fatalf("body does not contain <html>: %q", rec.Body.String())
	}
}

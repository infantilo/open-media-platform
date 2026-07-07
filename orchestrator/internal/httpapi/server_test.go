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
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// fakeNodeLister ist ein einfacher Test-Double für NodeLister, damit
// Handler-Tests ohne echten Poller/Registry-Client auskommen.
type fakeNodeLister struct{ nodes []registry.NodeView }

func (f fakeNodeLister) List() []registry.NodeView { return f.nodes }

func TestHandleHealthz(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{})

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
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{})

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

func TestHandleNodes(t *testing.T) {
	lister := fakeNodeLister{nodes: []registry.NodeView{
		{ID: "node-1", Label: "Fake Node", Online: true, Devices: []registry.DeviceView{}, Senders: []registry.SenderView{}, Receivers: []registry.ReceiverView{}},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body []registry.NodeView
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if len(body) != 1 || body[0].Label != "Fake Node" {
		t.Fatalf("nodes = %+v, want one Fake Node", body)
	}
}

func TestHandleNodesEmptyListSerializesAsEmptyArray(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if strings.TrimSpace(rec.Body.String()) != "[]" && strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("body = %q, want JSON array", rec.Body.String())
	}
}

func TestStaticUIServing(t *testing.T) {
	dir := t.TempDir()
	const html = "<html><body>OpenMediaPlatform UI-Platzhalter</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}

	h := NewHandler(config.Config{UIDir: dir}, fakeNodeLister{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
		t.Fatalf("body does not contain <html>: %q", rec.Body.String())
	}
}

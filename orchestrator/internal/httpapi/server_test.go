package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeNodeLister ist ein einfacher Test-Double für NodeLister, damit
// Handler-Tests ohne echten Poller/Registry-Client auskommen.
type fakeNodeLister struct{ nodes []registry.NodeView }

func (f fakeNodeLister) List() []registry.NodeView { return f.nodes }

func (f fakeNodeLister) Get(id string) (registry.NodeView, bool) {
	for _, n := range f.nodes {
		if n.ID == id {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

// fakeEventSubscriber ist ein Test-Double für EventSubscriber, das einen
// vorgegebenen Kanal statt eines echten sse.Hub liefert.
type fakeEventSubscriber struct {
	ch chan sse.Event
}

func (f fakeEventSubscriber) Subscribe() (<-chan sse.Event, func()) {
	return f.ch, func() {}
}

func TestHandleHealthz(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)})

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
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)})

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
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)})

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
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if strings.TrimSpace(rec.Body.String()) != "[]" && strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("body = %q, want JSON array", rec.Body.String())
	}
}

func TestHandleEventsStreamsBroadcastEvents(t *testing.T) {
	ch := make(chan sse.Event, 1)
	ch <- sse.Event{Type: "omp.health.test", Data: []byte(`{"ok":true}`)}

	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: ch})

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rec, req)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not return after context cancel")
	}

	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "omp.health.test") {
		t.Fatalf("body = %q, want to contain broadcast event type", body)
	}
	if !strings.Contains(body, `"ok":true`) {
		t.Fatalf("body = %q, want to contain event data", body)
	}
}

func TestHandleNodeProxyDescriptor(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/descriptor.json" {
			t.Errorf("proxied path = %q, want /descriptor.json", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"parameters":[{"name":"gain","type":"number","readonly":false}],"methods":[]}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/descriptor", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "gain") {
		t.Fatalf("body = %q, want to contain proxied descriptor", rec.Body.String())
	}
}

func TestHandleNodeProxyPatchParam(t *testing.T) {
	var gotBody string
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/params/gain" {
			t.Errorf("proxied request = %s %q, want PATCH /params/gain", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"value":-6}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", strings.NewReader(`{"value":-6}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotBody != `{"value":-6}` {
		t.Fatalf("proxied body = %q, want forwarded request body", gotBody)
	}
}

func TestHandleNodeProxyMethod(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/methods/reset" {
			t.Errorf("proxied request = %s %q, want POST /methods/reset", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/nodes/node-1/methods/reset", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandleNodeProxyUnknownNodeReturns404(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/does-not-exist/descriptor", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestStaticUIServing(t *testing.T) {
	dir := t.TempDir()
	const html = "<html><body>OpenMediaPlatform UI-Platzhalter</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}

	h := NewHandler(config.Config{UIDir: dir}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
		t.Fatalf("body does not contain <html>: %q", rec.Body.String())
	}
}

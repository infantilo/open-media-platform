package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher ist ein Test-Double für EventSubscriber, das nur
// die Typen der über Broadcast verteilten Events sammelt (Subscribe wird
// von handleRegisterHost nicht genutzt, bleibt ein No-Op).
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Subscribe() (<-chan sse.Event, func()) {
	return make(chan sse.Event), func() {}
}
func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }
func (f *fakeEventPublisher) ClientCount() int      { return 0 }
func (f *fakeEventPublisher) TotalDrops() uint64    { return 0 }

func TestHandleCreateBootstrapToken(t *testing.T) {
	expires := time.Now().Add(time.Hour)
	registry := fakeHostRegistry{token: "abc123", expiresAt: expires}
	h := handleCreateBootstrapToken(registry)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/hosts/bootstrap-tokens", nil))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	var body bootstrapTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.Token != "abc123" {
		t.Errorf("token = %q, want abc123", body.Token)
	}
}

func TestHandleRegisterHostSuccess(t *testing.T) {
	registry := fakeHostRegistry{createdHost: hosts.Host{ID: "host-1", Label: "Test Host"}}
	pub := &fakeEventPublisher{}
	h := handleRegisterHost(registry, pub)

	body := `{"token":"valid","label":"Test Host","hostname":"test.local","capabilities":{"cores":8}}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(body)))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
	var resp registerHostResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp.HostID != "host-1" || resp.Label != "Test Host" {
		t.Errorf("response = %+v, unexpected", resp)
	}
	if len(pub.types) != 1 || pub.types[0] != "host.registered" {
		t.Errorf("published events = %v, want [host.registered]", pub.types)
	}
}

func TestHandleRegisterHostSucceedsWithoutEventPublisher(t *testing.T) {
	registry := fakeHostRegistry{createdHost: hosts.Host{ID: "host-1", Label: "Test Host"}}
	h := handleRegisterHost(registry, nil)

	body := `{"token":"valid","label":"Test Host","hostname":"test.local"}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(body)))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleRegisterHostInvalidToken(t *testing.T) {
	registry := fakeHostRegistry{consumeErr: hosts.ErrInvalidToken}
	h := handleRegisterHost(registry, nil)

	body := `{"token":"bogus","label":"X","hostname":"x.local"}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(body)))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestHandleRegisterHostMissingFields(t *testing.T) {
	h := handleRegisterHost(fakeHostRegistry{}, nil)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(`{"token":"x"}`)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleListHostsMergesMetrics(t *testing.T) {
	registered := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	registry := fakeHostRegistry{list: []hosts.Host{
		{ID: "host-1", Label: "Host One", Hostname: "one.local", RegisteredAt: registered},
		{ID: "host-2", Label: "Host Two", Hostname: "two.local", RegisteredAt: registered},
	}}
	metrics := fakeHostMetrics{byHost: map[string]hosts.Metrics{
		"host-1": {CPUPercent: 12.5, MemUsedBytes: 100, MemTotalBytes: 1000},
	}}
	h := handleListHosts(registry, metrics)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/v1/hosts", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []hostResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body) != 2 {
		t.Fatalf("hosts = %+v, want 2 entries", body)
	}
	if body[0].Metrics == nil || body[0].Metrics.CPUPercent != 12.5 {
		t.Errorf("host-1 metrics = %+v, want CPUPercent 12.5", body[0].Metrics)
	}
	if body[1].Metrics != nil {
		t.Errorf("host-2 metrics = %+v, want nil (no telemetry seen yet)", body[1].Metrics)
	}
}

package httpapi

import (
	"encoding/json"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/maintenance"
	"io"
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
type fakeEventPublisher struct {
	types []string
	data  [][]byte
}

func (f *fakeEventPublisher) Subscribe() (<-chan sse.Event, func()) {
	return make(chan sse.Event), func() {}
}
func (f *fakeEventPublisher) Broadcast(e sse.Event) {
	f.types = append(f.types, e.Type)
	f.data = append(f.data, []byte(e.Data))
}
func (f *fakeEventPublisher) ClientCount() int   { return 0 }
func (f *fakeEventPublisher) TotalDrops() uint64 { return 0 }

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
	h := handleRegisterHost(registry, nil, pub)

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
	h := handleRegisterHost(registry, nil, nil)

	body := `{"token":"valid","label":"Test Host","hostname":"test.local"}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(body)))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleRegisterHostInvalidToken(t *testing.T) {
	registry := fakeHostRegistry{consumeErr: hosts.ErrInvalidToken}
	h := handleRegisterHost(registry, nil, nil)

	body := `{"token":"bogus","label":"X","hostname":"x.local"}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(body)))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestHandleRegisterHostMissingFields(t *testing.T) {
	h := handleRegisterHost(fakeHostRegistry{}, nil, nil)

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
	h := handleListHosts(registry, metrics, nil, nil)

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

func TestHandleHostMetricsHistoryReturnsWindow(t *testing.T) {
	want := hosts.HistoryWindow{
		Resolution: "raw",
		Samples:    []hosts.Sample{{CPUPercent: 12.5, MemPercent: 40}},
		Summary:    hosts.Summary{CPUMin: 12.5, CPUAvg: 12.5, CPUMax: 12.5, SampleCount: 1},
	}
	history := fakeHostHistory{byHost: map[string]hosts.HistoryWindow{"host-1": want}}
	h := handleHostMetricsHistory(history)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/hosts/host-1/metrics/history?window=1h", nil)
	req.SetPathValue("id", "host-1")
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var got hosts.HistoryWindow
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got.Resolution != "raw" || len(got.Samples) != 1 || got.Samples[0].CPUPercent != 12.5 {
		t.Errorf("history = %+v, unexpected", got)
	}
}

func TestHandleHostMetricsHistoryUnknownHostReturnsEmptyWindow(t *testing.T) {
	history := fakeHostHistory{byHost: map[string]hosts.HistoryWindow{}}
	h := handleHostMetricsHistory(history)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/hosts/ghost/metrics/history", nil)
	req.SetPathValue("id", "ghost")
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no error for a host with no telemetry yet)", rec.Code)
	}
	var got hosts.HistoryWindow
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(got.Samples) != 0 || len(got.Aggregates) != 0 {
		t.Errorf("history = %+v, want empty window", got)
	}
}

func TestHandleHostMetricsHistoryInvalidWindowFallsBackToDefault(t *testing.T) {
	history := fakeHostHistory{byHost: map[string]hosts.HistoryWindow{
		"host-1": {Resolution: "raw"},
	}}
	h := handleHostMetricsHistory(history)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/hosts/host-1/metrics/history?window=not-a-duration", nil)
	req.SetPathValue("id", "host-1")
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (invalid window silently falls back)", rec.Code)
	}
}

func TestHandleDeleteHost(t *testing.T) {
	online := fakeHostMetrics{byHost: map[string]hosts.Metrics{"on": {ReceivedAt: time.Now()}}}
	cases := []struct {
		name, id string
		reg      fakeHostRegistry
		want     int
	}{
		{"offline host removed", "off", fakeHostRegistry{}, http.StatusNoContent},
		{"online host refused", "on", fakeHostRegistry{}, http.StatusConflict},
		{"unknown host", "x", fakeHostRegistry{deleteErr: hosts.ErrHostNotFound}, http.StatusNotFound},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/hosts/"+c.id, nil)
		req.SetPathValue("id", c.id)
		rec := httptest.NewRecorder()
		handleDeleteHost(c.reg, online, nil)(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: status = %d, want %d", c.name, rec.Code, c.want)
		}
	}
}

type fakeMaint struct{ on map[string]bool }

func (f fakeMaint) Enter(string) error { return nil }
func (f fakeMaint) Leave(string) error { return nil }
func (f fakeMaint) Status(id string) (maintenance.Status, bool) {
	return maintenance.Status{}, f.on[id]
}

func TestBlockMaintenanceHost(t *testing.T) {
	m := fakeMaint{on: map[string]bool{"wartung": true}}
	called := 0
	h := blockMaintenanceHost(m, "hostId", func(w http.ResponseWriter, r *http.Request) {
		called++
		b, _ := io.ReadAll(r.Body)
		if len(b) == 0 {
			t.Error("body must stay readable")
		}
	})
	for body, want := range map[string]int{`{"hostId":"wartung"}`: http.StatusConflict, `{"hostId":"frei"}`: http.StatusOK, `{}`: http.StatusOK} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)))
		if rec.Code != want {
			t.Errorf("%s: status = %d, want %d", body, rec.Code, want)
		}
	}
	if called != 2 {
		t.Errorf("next called %d times, want 2", called)
	}
}

type keyIssuingRegistry struct {
	fakeHostRegistry
	key string
}

func (k keyIssuingRegistry) IssueCommandKey(string) (string, error) { return k.key, nil }

func TestHandleRegisterHostDeliversCommandKeyOnlyInResponse(t *testing.T) {
	registry := keyIssuingRegistry{fakeHostRegistry{createdHost: hosts.Host{ID: "host-1", Label: "Test Host"}}, "geheimer-kommandoschluessel-0123456789"}
	pub := &fakeEventPublisher{}
	h := handleRegisterHost(registry, nil, pub)
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/v1/hosts/register", strings.NewReader(`{"token":"valid","label":"T","hostname":"t.local"}`)))
	var resp registerHostResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.CommandKey != registry.key {
		t.Fatalf("Antwort: %s %v", rec.Body.String(), err)
	}
	for _, d := range pub.data {
		if strings.Contains(string(d), registry.key) {
			t.Fatal("der Schlüssel darf nie in einem SSE-Ereignis stehen")
		}
	}
}

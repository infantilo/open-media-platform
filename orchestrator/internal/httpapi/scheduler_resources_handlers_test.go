package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

func TestSchedulerResourcesModel(t *testing.T) {
	reg := fakeHostRegistry{list: []hosts.Host{
		{ID: "h1", Label: "Regie A", Capabilities: []byte(`{"numCPU":8}`)},
		{ID: "h2", Label: "Regie B (offline)", Capabilities: []byte(`{"numCPU":4}`)},
	}}
	metrics := fakeHostMetrics{byHost: map[string]hosts.Metrics{
		"h1": {CPUPercent: 40, MemUsedBytes: 4 << 30, MemTotalBytes: 16 << 30, ReceivedAt: time.Now()},
		"h2": {CPUPercent: 10, MemUsedBytes: 1 << 30, MemTotalBytes: 8 << 30, ReceivedAt: time.Now().Add(-time.Hour)},
	}}
	prof := fakeProfileReader{snapshots: map[[2]string]profiles.Snapshot{
		// host-spezifisch: p95 250 % = 2,5 Kerne, RSS max 2 GiB
		{"omp-video-mixer-me", "h1"}: {NodeType: "omp-video-mixer-me", HostID: "h1", CPUAvg: 180, CPUP95: 250, RSSAvg: 1 << 30, RSSMax: 2 << 30, SampleCount: 10},
		// nur globaler Fallback
		{"omp-source", profiles.GlobalHostID}: {NodeType: "omp-source", HostID: profiles.GlobalHostID, CPUAvg: 30, CPUP95: 20, RSSAvg: 100 << 20, RSSMax: 90 << 20, SampleCount: 5},
	}}
	wf := fakeWorkflowService{list: []workflows.Workflow{{
		ID: "w1", Name: "Show", Status: workflows.StatusStopped,
		Definition: workflows.Definition{Roles: []workflows.Role{
			{Name: "Mix", NodeType: "omp-video-mixer-me", HostID: "h1"},
			{Name: "Quelle", NodeType: "omp-source"},
			{Name: "Unbekannt", NodeType: "omp-neu"},
			{Name: "Karte", NodeType: "omp-decklink", RequiredIOPort: &workflows.IOPortRequirement{CardType: "decklink", Direction: "in"}},
		}},
	}}}

	rec := httptest.NewRecorder()
	handleSchedulerResources(reg, metrics, nil, prof, wf, placement.DefaultThresholds)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/scheduler/resources", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp schedResResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if len(resp.Hosts) != 3 || !resp.Hosts[0].Local || resp.Hosts[0].NumCPU < 1 {
		t.Fatalf("hosts = %+v (lokaler Host zuerst erwartet)", resp.Hosts)
	}
	h1, h2 := resp.Hosts[1], resp.Hosts[2]
	if !h1.Online || h1.NumCPU != 8 || h1.MemTotal != 16<<30 || h1.Live == nil || h1.Live.MemPercent != 25 {
		t.Errorf("h1 = %+v live=%+v", h1, h1.Live)
	}
	if h2.Online {
		t.Errorf("h2 with stale telemetry must be offline: %+v", h2)
	}

	if len(resp.Workflows) != 1 {
		t.Fatalf("workflows = %d", len(resp.Workflows))
	}
	roles := map[string]schedResRole{}
	for _, r := range resp.Workflows[0].Roles {
		roles[r.Name] = r
	}
	mix := roles["Mix"]
	if !mix.Known || mix.Fallback || mix.CPUCores != 2.5 || mix.RSSBytes != 2<<30 || mix.HostID != "h1" {
		t.Errorf("Mix = %+v", mix)
	}
	src := roles["Quelle"]
	// p95 (20) < avg (30) → Avg zählt (nie unter dem Mittelwert planen)
	if !src.Known || src.CPUCores != 0.3 || src.HostID != "" {
		t.Errorf("Quelle = %+v", src)
	}
	if roles["Unbekannt"].Known {
		t.Error("role without any profile must be reported as unknown, never as zero demand")
	}
	if p := roles["Karte"].IOPort; p == nil || p.CardType != "decklink" || p.Direction != "in" {
		t.Errorf("Karte ioPort = %+v", p)
	}
	if resp.Thresholds["cpu"] != placement.DefaultThresholds.CPUPercent {
		t.Errorf("thresholds = %v", resp.Thresholds)
	}
}

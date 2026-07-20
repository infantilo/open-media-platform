package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

func TestHandleGetProfileUnknown(t *testing.T) {
	store := fakeProfileReader{}
	h := handleGetProfile(store, fakeHostMetrics{}, placement.DefaultThresholds)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/profiles?nodeType=omp-source&hostId=", nil)
	h(rec, req)

	var resp profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp.Known || resp.Status != "unbekannt" {
		t.Errorf("resp = %+v, want known=false status=unbekannt", resp)
	}
}

func TestHandleGetProfileLocalHostNoCapacityComparison(t *testing.T) {
	store := fakeProfileReader{snapshots: map[[2]string]profiles.Snapshot{
		{"omp-source", ""}: {NodeType: "omp-source", HostID: "", CPUAvg: 15, CPUMax: 20, RSSAvg: 30_000_000},
	}}
	h := handleGetProfile(store, fakeHostMetrics{}, placement.DefaultThresholds)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/profiles?nodeType=omp-source&hostId=", nil)
	h(rec, req)

	var resp profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !resp.Known || resp.Status != "lokal" || resp.CPUAvg != 15 {
		t.Errorf("resp = %+v, want known=true status=lokal cpuAvg=15", resp)
	}
	if resp.HostCPUPercent != nil {
		t.Errorf("resp.HostCPUPercent = %v, want nil (kein Kapazitätsvergleich für lokalen Host)", resp.HostCPUPercent)
	}
}

func TestHandleGetProfileFallsBackToGlobalProfile(t *testing.T) {
	store := fakeProfileReader{snapshots: map[[2]string]profiles.Snapshot{
		{"omp-source", profiles.GlobalHostID}: {NodeType: "omp-source", HostID: profiles.GlobalHostID, CPUAvg: 25, RSSAvg: 10_000_000},
	}}
	h := handleGetProfile(store, fakeHostMetrics{}, placement.DefaultThresholds)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/profiles?nodeType=omp-source&hostId=host-new", nil)
	h(rec, req)

	var resp profileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !resp.Known || !resp.Fallback || resp.CPUAvg != 25 {
		t.Errorf("resp = %+v, want known=true fallback=true cpuAvg=25", resp)
	}
}

func TestHandleGetProfileRemoteHostStatusThresholds(t *testing.T) {
	store := fakeProfileReader{snapshots: map[[2]string]profiles.Snapshot{
		{"omp-video-mixer-me", "host-a"}: {NodeType: "omp-video-mixer-me", HostID: "host-a", CPUAvg: 10},
	}}
	thresholds := placement.Thresholds{CPUPercent: 85, MemPercent: 90, HealthyCPUPercent: 60, HealthyMemPercent: 70}

	cases := []struct {
		name       string
		hostCPU    float64
		wantStatus string
	}{
		{"host mostly idle -> ok", 20, "ok"},                // 20+10=30, unter Healthy (60)
		{"host busy -> knapp", 55, "knapp"},                 // 55+10=65, über Healthy, unter Alarm
		{"host overloaded -> ueberbucht", 80, "ueberbucht"}, // 80+10=90, über Alarm (85)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hostMetrics := fakeHostMetrics{byHost: map[string]hosts.Metrics{
				"host-a": {CPUPercent: tc.hostCPU, MemUsedBytes: 0, MemTotalBytes: 0},
			}}
			h := handleGetProfile(store, hostMetrics, thresholds)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/api/v1/profiles?nodeType=omp-video-mixer-me&hostId=host-a", nil)
			h(rec, req)

			var resp profileResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("invalid JSON: %v", err)
			}
			if resp.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q (resp=%+v)", resp.Status, tc.wantStatus, resp)
			}
		})
	}
}

func TestHandleGetProfileMissingNodeType(t *testing.T) {
	h := handleGetProfile(fakeProfileReader{}, fakeHostMetrics{}, placement.DefaultThresholds)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/profiles", nil)
	h(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cloud"
)

func mockCosts() *cloud.CostService {
	return &cloud.CostService{Provider: cloud.NewMockProvider(), Region: "r", MinBilled: time.Minute, Lead: 5 * time.Minute, Teardown: 5 * time.Minute}
}

func TestCloudPricingUnconfiguredIsNotAnError(t *testing.T) {
	rec := httptest.NewRecorder()
	handleCloudPricing(nil, "", "")(rec, httptest.NewRequest("GET", "/api/v1/cloud/pricing", nil))
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 200 || body["configured"] != false {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestCloudPricingListsTypes(t *testing.T) {
	rec := httptest.NewRecorder()
	handleCloudPricing(mockCosts(), "mock", "r")(rec, httptest.NewRequest("GET", "/api/v1/cloud/pricing", nil))
	var body struct {
		Configured    bool                 `json:"configured"`
		Provider      string               `json:"provider"`
		InstanceTypes []cloud.InstanceType `json:"instanceTypes"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 200 || !body.Configured || body.Provider != "mock" || len(body.InstanceTypes) != 2 || body.InstanceTypes[0].PricePerHour <= 0 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestCloudEstimateComputesCostAndFlagsEstimate(t *testing.T) {
	body := `{"demands":[{"instanceType":"g.large","count":2,"from":"2026-10-08T11:00:00Z","to":"2026-10-08T14:00:00Z"}],"leadSeconds":300,"teardownSeconds":300}`
	rec := httptest.NewRecorder()
	handleCloudEstimate(mockCosts())(rec, httptest.NewRequest("POST", "/api/v1/cloud/estimate", strings.NewReader(body)))
	var est cloud.Estimate
	if err := json.Unmarshal(rec.Body.Bytes(), &est); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	// 2 Hosts × (3 h + 10 min) × 0,90 €/h
	want := 2 * 0.90 * (3.0 + 10.0/60)
	if !est.Estimated || est.Currency != "EUR" || est.Total < want-1e-4 || est.Total > want+1e-4 || len(est.Runs) != 2 {
		t.Fatalf("%+v want total %v", est, want)
	}
}

func TestCloudEstimateErrors(t *testing.T) {
	cases := []struct {
		name string
		c    CloudCosts
		body string
		code int
	}{
		{"unconfigured", nil, `{}`, http.StatusServiceUnavailable},
		{"bad json", mockCosts(), `{`, http.StatusBadRequest},
		{"unknown type", mockCosts(), `{"demands":[{"instanceType":"zzz","count":1,"from":"2026-10-08T11:00:00Z","to":"2026-10-08T12:00:00Z"}]}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		handleCloudEstimate(tc.c)(rec, httptest.NewRequest("POST", "/", strings.NewReader(tc.body)))
		if rec.Code != tc.code {
			t.Errorf("%s: got %d want %d (%s)", tc.name, rec.Code, tc.code, rec.Body.String())
		}
	}
}

type failingProvider struct{ *cloud.MockProvider }

func (failingProvider) Catalog(context.Context, string) ([]cloud.InstanceType, error) {
	return nil, context.DeadlineExceeded
}

func TestCloudPricingProviderFailureIs502(t *testing.T) {
	svc := &cloud.CostService{Provider: failingProvider{cloud.NewMockProvider()}, Region: "r"}
	rec := httptest.NewRecorder()
	handleCloudPricing(svc, "x", "r")(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("%d", rec.Code)
	}
}

type fakeControl struct {
	created []cloud.ReservationInput
	deleted []string
}

func (f *fakeControl) Pools() []cloud.PoolInfo { return []cloud.PoolInfo{{Name: "burst", Max: 3}} }
func (f *fakeControl) Hosts() []cloud.Host     { return []cloud.Host{{ID: "h1", Pool: "burst", State: cloud.HostReady}} }
func (f *fakeControl) Actions() []cloud.Action { return nil }
func (f *fakeControl) List(time.Time, time.Time) ([]cloud.Reservation, error) {
	return []cloud.Reservation{{ID: "r1", Pool: "burst", HostCount: 2}}, nil
}
func (f *fakeControl) Create(in cloud.ReservationInput, by string) (cloud.Reservation, error) {
	if in.HostCount > 3 {
		return cloud.Reservation{}, cloud.ErrReservationValidation
	}
	f.created = append(f.created, in)
	return cloud.Reservation{ID: "r9", Pool: in.Pool, HostCount: in.HostCount, CreatedBy: by}, nil
}
func (f *fakeControl) Delete(id string) error {
	if id == "nope" {
		return cloud.ErrReservationNotFound
	}
	f.deleted = append(f.deleted, id)
	return nil
}

func TestCloudHostsAndReservationsEndpoints(t *testing.T) {
	f := &fakeControl{}
	rec := httptest.NewRecorder()
	handleCloudHosts(f)(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":true`) || !strings.Contains(rec.Body.String(), `"h1"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleCloudHosts(nil)(rec, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatal(rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleListReservations(f)(rec, httptest.NewRequest("GET", "/?from=2026-10-08T00:00:00Z&to=2026-10-09T00:00:00Z", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"r1"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleListReservations(f)(rec, httptest.NewRequest("GET", "/?from=gestern", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatal(rec.Code)
	}
}

func TestCreateAndDeleteReservation(t *testing.T) {
	f := &fakeControl{}
	rec := httptest.NewRecorder()
	handleCreateReservation(f, nil)(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"pool":"burst","hostCount":2,"from":"2026-10-08T11:00:00Z","to":"2026-10-08T12:00:00Z"}`)))
	if rec.Code != http.StatusCreated || len(f.created) != 1 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleCreateReservation(f, nil)(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"pool":"burst","hostCount":9,"from":"2026-10-08T11:00:00Z","to":"2026-10-08T12:00:00Z"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("validation must be 400, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleCreateReservation(nil, nil)(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatal(rec.Code)
	}
	for id, want := range map[string]int{"r1": http.StatusNoContent, "nope": http.StatusNotFound} {
		rec = httptest.NewRecorder()
		req := httptest.NewRequest("DELETE", "/", nil)
		req.SetPathValue("id", id)
		handleDeleteReservation(f, nil)(rec, req)
		if rec.Code != want {
			t.Errorf("%s: %d want %d", id, rec.Code, want)
		}
	}
}

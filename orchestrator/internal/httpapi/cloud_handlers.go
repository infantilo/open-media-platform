package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cloud"
)

// CloudCosts ist die Kostensicht auf den konfigurierten Cloud-Anbieter (ARCHITECTURE.md §27.3);
// *cloud.CostService erfüllt sie. Ohne Anbieter bleibt sie nil: die Endpunkte melden dann
// `configured:false` statt zu scheitern.
type CloudCosts interface {
	Types(ctx context.Context) ([]cloud.InstanceType, error)
	Estimate(ctx context.Context, demands []cloud.Demand, lead, teardown time.Duration) (cloud.Estimate, error)
}

// WithCloud aktiviert /api/v1/cloud/pricing und /api/v1/cloud/estimate.
func WithCloud(c CloudCosts, provider, region string) HandlerOption {
	return func(o *handlerOptions) { o.cloud, o.cloudProvider, o.cloudRegion = c, provider, region }
}

// handleCloudPricing: GET /api/v1/cloud/pricing — buchbare Instanztypen mit Preis (Schätzbasis, keine Abrechnung).
func handleCloudPricing(c CloudCosts, provider, region string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			writeJSON(w, http.StatusOK, map[string]any{"configured": false, "instanceTypes": []cloud.InstanceType{}})
			return
		}
		types, err := c.Types(r.Context())
		if err != nil {
			http.Error(w, "cloud provider: "+err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"configured": true, "provider": provider, "region": region, "instanceTypes": types})
	}
}

type cloudEstimateRequest struct {
	Demands         []cloud.Demand `json:"demands"`
	LeadSeconds     float64        `json:"leadSeconds"`
	TeardownSeconds float64        `json:"teardownSeconds"`
}

// handleCloudEstimate: POST /api/v1/cloud/estimate — Kostenvorberechnung für einen Hostbedarf.
func handleCloudEstimate(c CloudCosts) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			http.Error(w, "no cloud provider configured", http.StatusServiceUnavailable)
			return
		}
		var req cloudEstimateRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if len(req.Demands) > 1000 {
			http.Error(w, "too many demands", http.StatusBadRequest)
			return
		}
		est, err := c.Estimate(r.Context(), req.Demands,
			time.Duration(req.LeadSeconds*float64(time.Second)), time.Duration(req.TeardownSeconds*float64(time.Second)))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, est)
	}
}

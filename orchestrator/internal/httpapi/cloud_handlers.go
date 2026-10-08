package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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

// CloudControl ist die Steuersicht auf Cloud-Hosts und Reservierungen (*cloud.Service erfüllt sie).
type CloudControl interface {
	Pools() []cloud.PoolInfo
	Hosts() []cloud.Host
	Actions() []cloud.Action
	List(from, to time.Time) ([]cloud.Reservation, error)
	Create(in cloud.ReservationInput, by string) (cloud.Reservation, error)
	Delete(id string) error
}

// WithCloudControl aktiviert /api/v1/cloud/hosts und /api/v1/cloud/reservations*.
func WithCloudControl(c CloudControl) HandlerOption {
	return func(o *handlerOptions) { o.cloudControl = c }
}

// handleCloudHosts: GET /api/v1/cloud/hosts — gemietete Hosts, Pools und die letzten Controller-Aktionen.
func handleCloudHosts(c CloudControl) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			writeJSON(w, http.StatusOK, map[string]any{"configured": false, "pools": []any{}, "hosts": []any{}, "actions": []any{}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"configured": true, "pools": c.Pools(), "hosts": c.Hosts(), "actions": c.Actions()})
	}
}

// handleListReservations: GET /api/v1/cloud/reservations?from=&to= (RFC 3339; Standard: gestern bis +60 Tage).
func handleListReservations(c CloudControl) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			writeJSON(w, http.StatusOK, []any{})
			return
		}
		now := time.Now()
		from, to := now.Add(-24*time.Hour), now.Add(60*24*time.Hour)
		if v := r.URL.Query().Get("from"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				http.Error(w, "invalid from", http.StatusBadRequest)
				return
			}
			from = t
		}
		if v := r.URL.Query().Get("to"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				http.Error(w, "invalid to", http.StatusBadRequest)
				return
			}
			to = t
		}
		list, err := c.List(from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// handleCreateReservation: POST /api/v1/cloud/reservations — Cloud-Kapazität von–bis anfordern.
func handleCreateReservation(c CloudControl, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			http.Error(w, "no cloud provider configured", http.StatusServiceUnavailable)
			return
		}
		var in cloud.ReservationInput
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
			http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
			return
		}
		res, err := c.Create(in, actorFromRequest(r))
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, cloud.ErrReservationValidation) {
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "cloud_reservation", res.ID, "created",
			map[string]any{"pool": res.Pool, "hostCount": res.HostCount, "from": res.From, "to": res.To})
		writeJSON(w, http.StatusCreated, res)
	}
}

// handleDeleteReservation: DELETE /api/v1/cloud/reservations/{id}.
func handleDeleteReservation(c CloudControl, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			http.Error(w, "no cloud provider configured", http.StatusServiceUnavailable)
			return
		}
		id := r.PathValue("id")
		if err := c.Delete(id); err != nil {
			if errors.Is(err, cloud.ErrReservationNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "cloud_reservation", id, "deleted", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}

// WithAll fasst mehrere Optionen zu einer zusammen.
func WithAll(opts ...HandlerOption) HandlerOption {
	return func(o *handlerOptions) {
		for _, f := range opts {
			f(o)
		}
	}
}

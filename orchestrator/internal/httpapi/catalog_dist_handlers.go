package httpapi

// Verteilung importierter Container-Microservices auf Hosts (Kap. 85, UMSETZUNG.md). Alle schreibenden Routen sind
// admin-only wie der Import selbst; der Bundle-Download ist (wie host-updates) durch ein kurzlebiges Token geschützt.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/catalogdist"
)

// CatalogDistributor ist die vom Handler benötigte Teilmenge von *catalogdist.Service.
type CatalogDistributor interface {
	Distribute(typ, version string, hostIDs []string) error
	Withdraw(typ, version string, hostIDs []string) error
	Retry(typ, version, hostID string) error
	Rows() ([]catalogdist.Row, error)
	BundleFile(id string) (string, bool)
	CheckToken(id, token string) bool
}

// WithCatalogDistributor aktiviert /api/v1/catalog/{type}/hosts, /api/v1/catalog/distribution und /api/v1/host-catalog/{id}.
func WithCatalogDistributor(d CatalogDistributor) HandlerOption {
	return func(o *handlerOptions) { o.catalogDist = d }
}

type distRequest struct {
	Version string   `json:"version"`
	HostIDs []string `json:"hostIds"`
	HostID  string   `json:"hostId"`
}

func distUnavailable(w http.ResponseWriter) {
	http.Error(w, "Verteilung auf Hosts ist nicht aktiviert", http.StatusServiceUnavailable)
}

// handleListCatalogDistribution: GET /api/v1/catalog/distribution — Zustand je (Typ, Version, Host).
func handleListCatalogDistribution(d CatalogDistributor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d == nil {
			writeJSON(w, http.StatusOK, []catalogdist.Row{})
			return
		}
		rows, err := d.Rows()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if rows == nil {
			rows = []catalogdist.Row{}
		}
		writeJSON(w, http.StatusOK, rows)
	}
}

// handleDistributeCatalog: POST /api/v1/catalog/{type}/hosts {"version","hostIds":[…]}.
func handleDistributeCatalog(d CatalogDistributor, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d == nil {
			distUnavailable(w)
			return
		}
		var req distRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		typ := r.PathValue("type")
		if err := d.Distribute(typ, req.Version, req.HostIDs); err != nil {
			writeDistError(w, err)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "catalog", typ, "distribute", map[string]any{"version": req.Version, "hosts": req.HostIDs})
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	}
}

// handleWithdrawCatalog: DELETE /api/v1/catalog/{type}/hosts?version=…[&hostId=…] — ohne hostId von allen Hosts.
func handleWithdrawCatalog(d CatalogDistributor, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d == nil {
			distUnavailable(w)
			return
		}
		typ, version := r.PathValue("type"), r.URL.Query().Get("version")
		var hosts []string
		if h := r.URL.Query().Get("hostId"); h != "" {
			hosts = []string{h}
		}
		if err := d.Withdraw(typ, version, hosts); err != nil {
			writeDistError(w, err)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "catalog", typ, "withdraw", map[string]any{"version": version, "hosts": hosts})
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	}
}

// handleRetryCatalogDistribution: POST /api/v1/catalog/{type}/hosts/retry {"version","hostId"}.
func handleRetryCatalogDistribution(d CatalogDistributor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d == nil {
			distUnavailable(w)
			return
		}
		var req distRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := d.Retry(r.PathValue("type"), req.Version, req.HostID); err != nil {
			writeDistError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	}
}

func writeDistError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, catalogdist.ErrUnknownType):
		http.Error(w, err.Error(), http.StatusNotFound)
	case strings.Contains(err.Error(), "unzulässig") || strings.Contains(err.Error(), "kein Host") || strings.Contains(err.Error(), "keine Verteilung"):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleHostCatalogDownload: GET /api/v1/host-catalog/{id}?token=… — bewusst außerhalb des Auth-Gates (Host-Agents haben
// keine Zugangsdaten); das kurzlebige, nur für dieses Bundle gültige Token aus der Verteilung ist die Zugriffskontrolle.
func handleHostCatalogDownload(d CatalogDistributor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d == nil {
			http.NotFound(w, r)
			return
		}
		id := r.PathValue("id")
		if !d.CheckToken(id, r.URL.Query().Get("token")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		path, ok := d.BundleFile(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/x-tar")
		http.ServeFile(w, r, path)
	}
}

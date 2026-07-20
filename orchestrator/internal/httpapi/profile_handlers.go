package httpapi

import (
	"context"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// ProfileReader liefert das aggregierte Verbrauchsprofil eines Node-Typs
// (implementiert von *profiles.Store, Kapitel 14 Teil 3).
type ProfileReader interface {
	Get(ctx context.Context, nodeType, hostID string) (profiles.Snapshot, bool, error)
}

// profileResponse ist die JSON-Antwort von GET /api/v1/profiles — known
// bleibt false, solange weder ein host-spezifisches noch ein
// Typ-Fallback-Profil existiert (§14.3d: "ehrlich 'Bedarf unbekannt
// (erster Start dieses Typs)', nie ein stiller Block").
type profileResponse struct {
	NodeType    string  `json:"nodeType"`
	HostID      string  `json:"hostId"`
	Known       bool    `json:"known"`
	Fallback    bool    `json:"fallback,omitempty"`
	CPUMin      float64 `json:"cpuMin,omitempty"`
	CPUAvg      float64 `json:"cpuAvg,omitempty"`
	CPUMax      float64 `json:"cpuMax,omitempty"`
	CPUP95      float64 `json:"cpuP95,omitempty"`
	RSSMin      uint64  `json:"rssMin,omitempty"`
	RSSAvg      uint64  `json:"rssAvg,omitempty"`
	RSSMax      uint64  `json:"rssMax,omitempty"`
	SampleCount int     `json:"sampleCount,omitempty"`
	// Status ist die Ampel (§14.3d): "ok"/"knapp"/"ueberbucht" nur mit
	// echten Host-Momentwerten berechenbar (HostCPUPercent/
	// HostMemPercent gesetzt) — "lokal" für hostId=="" (der Orchestrator
	// misst seinen eigenen Host heute nicht, ehrliche Grenze statt
	// erfundener Zahlen), "unbekannt" für einen Host ohne jemals
	// empfangene Telemetrie.
	Status              string   `json:"status"`
	HostCPUPercent      *float64 `json:"hostCpuPercent,omitempty"`
	HostMemPercent      *float64 `json:"hostMemPercent,omitempty"`
	ProjectedCPUPercent *float64 `json:"projectedCpuPercent,omitempty"`
	ProjectedMemPercent *float64 `json:"projectedMemPercent,omitempty"`
}

// handleGetProfile ist GET /api/v1/profiles?nodeType=X&hostId=Y (hostId
// leer = lokaler Host) — Kapitel 14 Teil 3 (docs/END-GOAL-
// FEATURES.md §14.3d). View-artig wie /api/v1/hosts (kein eigener
// Verb-Scope). Fällt auf profiles.GlobalHostID zurück, wenn für den
// konkreten Host noch kein eigenes Profil existiert (§14.3c: "ein neuer
// Host ohne eigene Messhistorie erbt das Typ-Profil, im UI klar als
// Schätzung gekennzeichnet" — Fallback=true zeigt das an).
func handleGetProfile(store ProfileReader, hostMetrics HostMetricsReader, thresholds placement.Thresholds) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		nodeType := r.URL.Query().Get("nodeType")
		if nodeType == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeType required"})
			return
		}
		hostID := r.URL.Query().Get("hostId")

		snap, ok, err := store.Get(r.Context(), nodeType, hostID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		fallback := false
		if !ok && hostID != profiles.GlobalHostID {
			snap, ok, err = store.Get(r.Context(), nodeType, profiles.GlobalHostID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			fallback = ok
		}

		resp := profileResponse{NodeType: nodeType, HostID: hostID, Known: ok}
		if !ok {
			resp.Status = "unbekannt"
			writeJSON(w, http.StatusOK, resp)
			return
		}
		resp.Fallback = fallback
		resp.CPUMin, resp.CPUAvg, resp.CPUMax, resp.CPUP95 = snap.CPUMin, snap.CPUAvg, snap.CPUMax, snap.CPUP95
		resp.RSSMin, resp.RSSAvg, resp.RSSMax = snap.RSSMin, snap.RSSAvg, snap.RSSMax
		resp.SampleCount = snap.SampleCount

		if hostID == "" {
			// Der Orchestrator misst seinen eigenen (lokalen) Host nicht
			// (kein Host-Agent für sich selbst, s. Paketdoku) — Profilzahlen
			// bleiben trotzdem nützlich, nur ohne Kapazitätsvergleich.
			resp.Status = "lokal"
			writeJSON(w, http.StatusOK, resp)
			return
		}

		m, ok := hostMetrics.Get(hostID)
		if !ok {
			resp.Status = "unbekannt"
			writeJSON(w, http.StatusOK, resp)
			return
		}
		hostMemPercent := 0.0
		if m.MemTotalBytes > 0 {
			hostMemPercent = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
		}
		profileMemPercent := 0.0
		if m.MemTotalBytes > 0 {
			profileMemPercent = float64(snap.RSSAvg) / float64(m.MemTotalBytes) * 100
		}
		projectedCPU := m.CPUPercent + snap.CPUAvg
		projectedMem := hostMemPercent + profileMemPercent

		status := "ok"
		if projectedCPU > thresholds.CPUPercent || projectedMem > thresholds.MemPercent {
			status = "ueberbucht"
		} else if projectedCPU > thresholds.HealthyCPUPercent || projectedMem > thresholds.HealthyMemPercent {
			status = "knapp"
		}

		resp.Status = status
		resp.HostCPUPercent = &m.CPUPercent
		resp.HostMemPercent = &hostMemPercent
		resp.ProjectedCPUPercent = &projectedCPU
		resp.ProjectedMemPercent = &projectedMem
		writeJSON(w, http.StatusOK, resp)
	}
}

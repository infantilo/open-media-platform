package httpapi

import (
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Netz-Angaben für den Signalweg-Tab (Nutzerauftrag 2026-10-07:
// "Bandbreite je Verbindung"). Eine einzelne IS-05-Verbindung hat keine
// eigene Messung — MXL zwischen Nodes eines Hosts ist Shared Memory, und
// über das Netz laufen nur Nodes mit Katalog-Feld `network` (Gateways).
// Deshalb: berechneter Bedarf je Instanz (derselbe Rechenweg wie der
// Scheduler, computeRoleNetwork) plus Auslastung/Kapazität der Karte des
// Hosts, auf dem sie läuft. Die UI ordnet das den Karten der Kette zu.

type graphNetInstance struct {
	NodeType  string  `json:"nodeType"`
	HostKey   string  `json:"hostKey"` // "" = lokaler Host
	RxMbps    float64 `json:"netRxMbps,omitempty"`
	TxMbps    float64 `json:"netTxMbps,omitempty"`
	Estimated bool    `json:"netEstimated,omitempty"`
}

type graphNetHost struct {
	Label    string  `json:"label"`
	LinkMbps float64 `json:"linkMbps,omitempty"`
	// Gemessener Durchsatz der Karte (Mbit/s); Percent nur mit bekannter
	// Link-Geschwindigkeit (Rx+Tx gegen eine Richtung, wie im Scheduler).
	RxMbps   float64  `json:"rxMbps,omitempty"`
	TxMbps   float64  `json:"txMbps,omitempty"`
	Percent  *float64 `json:"percent,omitempty"`
	Measured bool     `json:"measured"`
}

type graphNetResponse struct {
	GeneratedAt      time.Time                   `json:"generatedAt"`
	ThresholdPercent float64                     `json:"thresholdPercent"`
	Instances        map[string]graphNetInstance `json:"instances"` // Schlüssel: Instanz-ID
	Hosts            map[string]graphNetHost     `json:"hosts"`     // Schlüssel: hostKey
}

// handleGraphNetwork: GET /api/v1/graph/network.
func handleGraphNetwork(registry HostRegistry, metrics HostMetricsReader, catalog CatalogReader, th placement.Thresholds) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := graphNetResponse{
			GeneratedAt:      time.Now().UTC(),
			ThresholdPercent: th.NetPercent,
			Instances:        map[string]graphNetInstance{},
			Hosts:            map[string]graphNetHost{},
		}
		local := graphNetHost{Label: "lokal"}
		if lh := catalog.LocalHost(); lh != nil && lh.Net != nil {
			local = netHost("lokal", lh.Net.LinkMbps, lh.Net.RxBytesPerSec, lh.Net.TxBytesPerSec)
		}
		resp.Hosts[""] = local
		if all, err := registry.ListHosts(); err == nil {
			for _, h := range all {
				hh := graphNetHost{Label: h.Label}
				if m, ok := metrics.Get(h.ID); ok && m.Net != nil {
					hh = netHost(h.Label, m.Net.LinkMbps, m.Net.RxBytesPerSec, m.Net.TxBytesPerSec)
				}
				resp.Hosts[h.ID] = hh
			}
		}
		for _, inst := range catalog.List() {
			gi := graphNetInstance{NodeType: inst.Type, HostKey: inst.HostID}
			if rn, has := computeRoleNetwork(catalog, workflows.Definition{}, workflows.Role{Name: inst.Label, NodeType: inst.Type}); has {
				gi.RxMbps, gi.TxMbps, gi.Estimated = rn.RxMbps, rn.TxMbps, rn.Estimated
			}
			resp.Instances[inst.ID] = gi
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func netHost(label string, linkMbps, rxBps, txBps float64) graphNetHost {
	h := graphNetHost{Label: label, LinkMbps: linkMbps, RxMbps: rxBps * 8 / 1e6, TxMbps: txBps * 8 / 1e6, Measured: true}
	if linkMbps > 0 {
		v := (rxBps + txBps) * 8 / (linkMbps * 1e6) * 100
		h.Percent = &v
	}
	return h
}

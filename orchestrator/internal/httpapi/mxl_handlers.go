package httpapi

import (
	"net/http"
	"os"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/mxlflows"
)

// mxlFlowView ist ein Flow der lokalen MXL-Domain mit der zugeordneten OMP-Instanz (falls der Schreiber ein
// vom Orchestrator gestarteter Node ist).
type mxlFlowView struct {
	mxlflows.Flow
	// Instance: Instanz-ID des Schreibers, Label dazu. Leer bei Fremdprozessen (z. B. ein Container oder ein
	// von Hand gestartetes Werkzeug) und bei Resten ohne Schreiber.
	Instance      string `json:"instance,omitempty"`
	InstanceLabel string `json:"instanceLabel,omitempty"`
	InstanceType  string `json:"instanceType,omitempty"`
}

// handleMXLFlows liefert GET /api/v1/admin/mxl/flows: die Flows der lokalen MXL-Domain (OMP_MXL_DOMAIN, Standard
// /dev/shm/omp-mxl) mit Schreiber (PID, Programm, Container) und Rest-Erkennung. Gilt nur für den Rechner des
// Orchestrators: MXL ist host-lokal, entfernte Hosts hätten eine eigene Domain.
func handleMXLFlows(ls LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		domain := os.Getenv("OMP_MXL_DOMAIN")
		if domain == "" {
			domain = "/dev/shm/omp-mxl"
		}
		flows, err := mxlflows.Scan(domain, mxlflows.Options{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		byPID := map[int]struct{ id, label, typ string }{}
		if ls != nil {
			for _, in := range ls.List() {
				if in.PID > 0 && in.HostID == "" {
					byPID[in.PID] = struct{ id, label, typ string }{in.ID, in.Label, in.Type}
				}
			}
		}
		out := make([]mxlFlowView, 0, len(flows))
		for _, f := range flows {
			v := mxlFlowView{Flow: f}
			for _, wr := range f.Writers {
				if in, ok := byPID[wr.PID]; ok {
					v.Instance, v.InstanceLabel, v.InstanceType = in.id, in.label, in.typ
					break
				}
			}
			out = append(out, v)
		}
		writeJSON(w, http.StatusOK, map[string]any{"domain": domain, "flows": out})
	}
}

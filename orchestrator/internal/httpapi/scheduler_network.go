package httpapi

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Netz-Bedarf je Workflow-Rolle für den Scheduler (Nutzerwunsch
// 2026-10-01: "was hilft genug CPU, wenn die Bandbreite der Karte fehlt").
// Nur Node-Typen mit Katalog-Feld `network` belasten die NIC — MXL
// zwischen Nodes eines Hosts ist Shared Memory. Der Bedarf wird
// BERECHNET (Format × Bits pro Pixel), nicht gemessen: er steht vor dem
// Start fest. Rx und Tx werden getrennt geführt, weil die Karte
// vollduplex arbeitet.

// rtpOverhead: RTP/UDP/IP/Ethernet-Header bei ~1428 Byte Nutzlast je
// Paket (ST 2110-20, Standard-Paketierung) — rund 5 %.
const rtpOverhead = 1.05

// fallbackNetFormat gilt, wenn weder die Rolle noch der Workflow noch ein
// verbundener Nachbar ein Format festlegt: das Hauptzielformat des
// Projekts (1080p50). Das Ergebnis wird als Schätzung markiert.
const fallbackNetFormat = "1080p50"

type roleNetwork struct {
	TxMbps    float64
	RxMbps    float64
	Estimated bool
}

func catalogNetwork(cat CatalogReader, nodeType string) *launcher.CatalogNetwork {
	if cat == nil {
		return nil
	}
	for _, e := range cat.Catalog() {
		if e.Type == nodeType {
			return e.Network
		}
	}
	return nil
}

// resolveNetFormat sucht das Format einer Netz-Rolle: eigenes Format →
// Workflow-Programmformat → Format einer direkt verbundenen Rolle →
// Fallback (estimated=true).
func resolveNetFormat(def workflows.Definition, role workflows.Role) (name string, estimated bool) {
	if role.Format != "" {
		return role.Format, false
	}
	if def.Settings.ProgramFormat != "" {
		return def.Settings.ProgramFormat, false
	}
	byName := map[string]workflows.Role{}
	for _, r := range def.Roles {
		byName[r.Name] = r
	}
	for _, c := range def.Connections {
		other := ""
		if c.FromRole == role.Name {
			other = c.ToRole
		} else if c.ToRole == role.Name {
			other = c.FromRole
		}
		if o, ok := byName[other]; ok && o.Format != "" {
			return o.Format, false
		}
	}
	return fallbackNetFormat, true
}

// computeRoleNetwork liefert den NIC-Bedarf einer Rolle; ok=false, wenn der
// Node-Typ keinen Netzverkehr deklariert.
func computeRoleNetwork(cat CatalogReader, def workflows.Definition, role workflows.Role) (roleNetwork, bool) {
	n := catalogNetwork(cat, role.NodeType)
	if n == nil {
		return roleNetwork{}, false
	}
	var mbps float64
	est := false
	switch n.Kind {
	case "video":
		name, e := resolveNetFormat(def, role)
		w, h, fps, ok := workflows.FormatDimensions(name)
		if !ok {
			return roleNetwork{}, false
		}
		mbps = float64(w) * float64(h) * fps * n.BitsPerPixel * rtpOverhead / 1e6
		est = e
	case "fixed":
		mbps = n.Mbps
		est = true // Nennwert, keine Messung
	default:
		return roleNetwork{}, false
	}
	rn := roleNetwork{Estimated: est}
	if n.Direction == "in" {
		rn.RxMbps = mbps
	} else {
		rn.TxMbps = mbps
	}
	return rn, true
}

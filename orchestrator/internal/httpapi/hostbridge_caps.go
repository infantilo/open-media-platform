package httpapi

import (
	"encoding/json"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostbridge"
)

// hostBridgeCaps liefert die Brücken-Fähigkeiten eines Hosts (Kap. 108): zuerst die Telemetrie des Host-Agents
// (`bridges`), sonst die optionalen Felder der Registrierung "fabrics", "st2110", "aes67", "srt" (bool). Fehlt ein Feld oder ist der Host unbekannt (auch der
// Orchestrator-Rechner, ""), gilt die Fähigkeit als unbekannt und wird versucht; scheitert der Start, folgt der
// nächste Transport.
func hostBridgeCaps(reg HostRegistry, metrics HostMetricsReader) func(hostID string) hostbridge.Caps {
	return func(hostID string) hostbridge.Caps {
		if hostID == "" || reg == nil {
			return hostbridge.Caps{}
		}
		// Der Host-Agent meldet seine Fähigkeiten mit der Telemetrie (neuere Agents); sie gehen vor.
		if metrics != nil {
			if m, ok := metrics.Get(hostID); ok && m.Bridges != nil {
				b := *m.Bridges
				return hostbridge.Caps{Fabrics: &b.Fabrics, ST2110: &b.ST2110, AES67: &b.AES67, SRT: &b.SRT}
			}
		}
		hosts, err := reg.ListHosts()
		if err != nil {
			return hostbridge.Caps{}
		}
		for _, h := range hosts {
			if h.ID != hostID {
				continue
			}
			var c struct {
				Fabrics *bool `json:"fabrics"`
				ST2110  *bool `json:"st2110"`
				AES67   *bool `json:"aes67"`
				SRT     *bool `json:"srt"`
			}
			_ = json.Unmarshal(h.Capabilities, &c)
			return hostbridge.Caps{Fabrics: c.Fabrics, ST2110: c.ST2110, AES67: c.AES67, SRT: c.SRT}
		}
		return hostbridge.Caps{}
	}
}

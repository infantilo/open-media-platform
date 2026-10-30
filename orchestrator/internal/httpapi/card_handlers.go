package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/ioports"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// hostCardLister fragt einen Host-Agent nach den erkannten Capture-Karten (Launcher → Host-Agent).
type hostCardLister interface {
	CardsOnHost(hostID string) ([]launcher.CardConnector, error)
}

// cardPort ist ein Anschluss im Start-Assistenten.
type cardPort struct {
	PortID string `json:"portId"`
	Dir    string `json:"dir"`
	// State: "free" | "used".
	State      string `json:"state"`
	InstanceID string `json:"instanceId,omitempty"`
	Role       string `json:"role,omitempty"`
}

// cardDevice ist ein Gerät (Teilgerät/Duplex-Anschluss) mit seinen Ein- und Ausgängen.
type cardDevice struct {
	Vendor string     `json:"vendor"`
	Device int        `json:"device"`
	Name   string     `json:"name"`
	Ports  []cardPort `json:"ports"`
}

// detectedPorts macht aus den Anschlüssen des Agents Inventar-Ports (`<N>-in`/`<N>-out`).
func detectedPorts(hostID string, found []launcher.CardConnector) []ioports.Port {
	var out []ioports.Port
	for _, c := range found {
		if c.Dir != "in" && c.Dir != "out" {
			continue
		}
		out = append(out, ioports.Port{HostID: hostID, PortID: fmt.Sprintf("%s-%d-%s", c.Vendor, c.Device, c.Dir), CardType: c.Vendor, Direction: c.Dir, Label: c.Name})
	}
	return out
}

// mergeInventory ersetzt im bisherigen Inventar die Ports der erkannten Hersteller durch die erkannten; Ports anderer
// Hersteller (z. B. Matrox aus der Inventardatei) bleiben. Ohne Erkennung bleibt alles unverändert.
func mergeInventory(existing, detected []ioports.Port) []ioports.Port {
	if len(detected) == 0 {
		return existing
	}
	vendors := map[string]bool{}
	for _, p := range detected {
		vendors[p.CardType] = true
	}
	out := append([]ioports.Port{}, detected...)
	for _, p := range existing {
		if !vendors[p.CardType] {
			out = append(out, p)
		}
	}
	return out
}

// buildCards gruppiert die Ports eines Hosts nach Gerät und ergänzt den Belegungszustand.
func buildCards(hostID string, ports []ioports.Port, claims []ioports.Claim) []cardDevice {
	type key struct {
		vendor string
		device int
	}
	claimed := map[string]ioports.Claim{}
	for _, c := range claims {
		if c.HostID == hostID {
			claimed[c.PortID] = c
		}
	}
	devs := map[key]*cardDevice{}
	for _, p := range ports {
		if p.HostID != hostID || CardVendorOf(p.CardType) == "" {
			continue
		}
		seg := strings.Split(p.PortID, "-")
		if len(seg) != 3 || seg[0] != p.CardType || (seg[2] != "in" && seg[2] != "out") {
			continue // Ports alter Inventardateien ohne <Hersteller>-<N>-in|out erscheinen nicht im Assistenten
		}
		n, err := strconv.Atoi(seg[1])
		if err != nil {
			continue
		}
		dir := seg[2]
		k := key{p.CardType, n}
		d := devs[k]
		if d == nil {
			d = &cardDevice{Vendor: p.CardType, Device: n, Name: p.Label}
			devs[k] = d
		}
		cp := cardPort{PortID: p.PortID, Dir: dir, State: "free"}
		if c, ok := claimed[p.PortID]; ok {
			cp.State, cp.InstanceID, cp.Role = "used", c.InstanceID, c.Role
		}
		d.Ports = append(d.Ports, cp)
	}
	out := make([]cardDevice, 0, len(devs))
	for _, d := range devs {
		sort.Slice(d.Ports, func(i, j int) bool { return d.Ports[i].Dir < d.Ports[j].Dir })
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Vendor != out[j].Vendor {
			return out[i].Vendor < out[j].Vendor
		}
		return out[i].Device < out[j].Device
	})
	return out
}

// CardVendorOf: nicht leer für die Kartenhersteller, die der Karten-Node bedient.
func CardVendorOf(cardType string) string {
	switch cardType {
	case "decklink", "aja", "matrox":
		return cardType
	}
	return ""
}

// handleHostCards: GET /api/v1/hosts/{id}/cards — erkennt die Karten des Hosts neu (Host-Agent), gleicht das
// Port-Inventar ab und liefert Geräte mit Ein-/Ausgängen und Belegung (frei/belegt) für den Start-Assistenten.
func handleHostCards(svc LauncherService, ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hostID := r.PathValue("id")
		if ioPortStore == nil {
			writeJSON(w, http.StatusOK, map[string]any{"cards": []cardDevice{}, "detected": false})
			return
		}
		all, err := ioPortStore.ListAllPorts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		note := ""
		if l, ok := svc.(hostCardLister); ok {
			found, derr := l.CardsOnHost(hostID)
			switch {
			case derr != nil:
				note = "Kartenerkennung nicht möglich: " + derr.Error() // gespeichertes Inventar bleibt maßgeblich
			case len(found) > 0:
				var existing []ioports.Port
				for _, p := range all {
					if p.HostID == hostID {
						existing = append(existing, p)
					}
				}
				if err := ioPortStore.SetInventory(hostID, mergeInventory(existing, detectedPorts(hostID, found))); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				if all, err = ioPortStore.ListAllPorts(); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			}
		}
		claims, err := ioPortStore.ListClaims()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"cards": buildCards(hostID, all, claims), "note": note})
	}
}

package httpapi

import (
	"encoding/json"
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

// manualCardRequest legt Anschlüsse einer Karte an, die kein Plugin melden kann (Matrox xMIO/DSX: das SDK-Plugin
// stammt vom Betreiber und bringt keine Geräteabfrage mit). Jeder Eintrag in `connectors` ist ein Gerät:
// "duplex" (Eingang und Ausgang), "in" oder "out".
type manualCardRequest struct {
	Name       string   `json:"name"`
	Connectors []string `json:"connectors"`
}

const maxManualConnectors = 16

// addManualCard hängt die Geräte an das Inventar an (Gerätenummern ab der nächsten freien) und liefert die neuen Ports.
func addManualCard(hostID, vendor string, existing []ioports.Port, req manualCardRequest) ([]ioports.Port, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 60 {
		return nil, fmt.Errorf("name: 1 bis 60 Zeichen")
	}
	if n := len(req.Connectors); n < 1 || n > maxManualConnectors {
		return nil, fmt.Errorf("connectors: 1 bis %d Anschlüsse", maxManualConnectors)
	}
	next := 0
	for _, p := range existing {
		seg := strings.Split(p.PortID, "-")
		if p.CardType == vendor && len(seg) == 3 {
			if n, err := strconv.Atoi(seg[1]); err == nil && n >= next {
				next = n + 1
			}
		}
	}
	out := append([]ioports.Port{}, existing...)
	for i, kind := range req.Connectors {
		var dirs []string
		switch kind {
		case "duplex":
			dirs = []string{"in", "out"}
		case "in", "out":
			dirs = []string{kind}
		default:
			return nil, fmt.Errorf("connectors[%d]: %q ist nicht duplex|in|out", i, kind)
		}
		for _, d := range dirs {
			out = append(out, ioports.Port{HostID: hostID, PortID: fmt.Sprintf("%s-%d-%s", vendor, next+i, d), CardType: vendor, Direction: d, Label: name})
		}
	}
	return out, nil
}

// removeManualDevice entfernt ein Gerät aus dem Inventar; false, wenn einer seiner Anschlüsse belegt ist.
func removeManualDevice(vendor string, device int, existing []ioports.Port, claims []ioports.Claim, hostID string) ([]ioports.Port, bool) {
	prefix := fmt.Sprintf("%s-%d-", vendor, device)
	for _, c := range claims {
		if c.HostID == hostID && strings.HasPrefix(c.PortID, prefix) {
			return existing, false
		}
	}
	var out []ioports.Port
	for _, p := range existing {
		if !strings.HasPrefix(p.PortID, prefix) {
			out = append(out, p)
		}
	}
	return out, true
}

func hostPorts(all []ioports.Port, hostID string) []ioports.Port {
	var out []ioports.Port
	for _, p := range all {
		if p.HostID == hostID {
			out = append(out, p)
		}
	}
	return out
}

// handleAddManualCard: POST /api/v1/hosts/{id}/cards/manual {"name":"xMIO3","connectors":["duplex","duplex","in"]}.
func handleAddManualCard(ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ioPortStore == nil {
			http.Error(w, "no I/O port inventory configured", http.StatusNotImplemented)
			return
		}
		var req manualCardRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		hostID := r.PathValue("id")
		all, err := ioPortStore.ListAllPorts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		ports, err := addManualCard(hostID, "matrox", hostPorts(all, hostID), req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := ioPortStore.SetInventory(hostID, ports); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleRemoveManualCard: DELETE /api/v1/hosts/{id}/cards/manual/{device} — nur Matrox-Geräte, nur wenn kein Anschluss belegt ist.
func handleRemoveManualCard(ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ioPortStore == nil {
			http.Error(w, "no I/O port inventory configured", http.StatusNotImplemented)
			return
		}
		device, err := strconv.Atoi(r.PathValue("device"))
		if err != nil || device < 0 {
			http.Error(w, "device must be a number", http.StatusBadRequest)
			return
		}
		hostID := r.PathValue("id")
		all, err := ioPortStore.ListAllPorts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		claims, err := ioPortStore.ListClaims()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		ports, ok := removeManualDevice("matrox", device, hostPorts(all, hostID), claims, hostID)
		if !ok {
			http.Error(w, "a connector of this device is in use", http.StatusConflict)
			return
		}
		if err := ioPortStore.SetInventory(hostID, ports); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

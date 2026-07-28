package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Client fragt die Standard-IS-04-Query-API einer NMOS-Registry ab. Er
// kennt keine nmos-cpp-Spezifika, nur die Standard-REST-Pfade
// (ARCHITECTURE.md §2/§5: "kein Orchestrator-Sonderwissen").
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// NewClient erstellt einen Client für die Query-API unter baseURL (z. B.
// "http://localhost:8010"), Version v1.3.
func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{baseURL: baseURL, httpClient: httpClient}
}

// FetchSnapshot holt Nodes, Devices, Senders, Receivers und Flows von der
// Query-API und aggregiert sie zu einer normalisierten Node-Liste.
func (c *Client) FetchSnapshot(ctx context.Context) ([]NodeView, error) {
	var nodes []is04Node
	var devices []is04Device
	var senders []is04Sender
	var receivers []is04Receiver
	var flows []is04Flow

	for _, f := range []struct {
		path string
		dst  any
	}{
		{"nodes", &nodes},
		{"devices", &devices},
		{"senders", &senders},
		{"receivers", &receivers},
		{"flows", &flows},
	} {
		if err := c.getJSON(ctx, f.path, f.dst); err != nil {
			return nil, fmt.Errorf("fetch %s: %w", f.path, err)
		}
	}

	flowFormat := make(map[string]string, len(flows))
	for _, fl := range flows {
		flowFormat[fl.ID] = fl.Format
	}

	views := buildSnapshot(nodes, devices, senders, receivers, flows)

	// Nutzerfund 2026-07-28 (Regieplatz-1-Start scheiterte mit "role
	// omp-video-mixer-me has no sender", docs/decisions.md — Fortsetzung
	// des am 2026-07-24 dokumentierten, bis dahin ungelösten Bugs): die
	// ungefilterte Bulk-Liste `GET .../senders` (bzw. `/receivers`) der
	// nmos-cpp-Registry lässt reproduzierbar, dauerhaft (nicht nur kurz
	// transient) einzelne real vorhandene Ressourcen aus, während
	// `GET .../senders?device_id=<id>` dieselbe Ressource korrekt
	// liefert (live verifiziert: ein Mixer-Sender fehlte über mehrere
	// aufeinanderfolgende Poll-Zyklen konsequent in der Bulk-Antwort,
	// eine gezielte Device-gescopte Abfrage fand ihn sofort). Fix: für
	// jedes Device, das im Bulk-Ergebnis mit null Sendern UND null
	// Empfängern dasteht (der einzige beobachtete Verdachtsfall — ein
	// Device mit tatsächlich mindestens einer Ressource verhält sich
	// nicht so), eine gezielte Nachfrage genau für dieses Device. Bewusst
	// nicht pauschal für jedes Device (unnötige Zusatzlast pro Poll-
	// Zyklus für reine Control-Plane-Devices ohne jede Medien-Ressource,
	// z. B. omp-playout-automation).
	c.fillSuspiciouslyEmptyDevices(ctx, views, flowFormat)

	return views, nil
}

// fillSuspiciouslyEmptyDevices ergänzt Sender/Receiver für Devices, die im
// Bulk-Ergebnis leer erscheinen, per gezielter Device-gescopter Nachfrage
// (s. FetchSnapshot-Doku). Mutiert views in place. Fehler bei der
// Nachfrage sind nicht fatal (der Poll insgesamt bleibt gültig, das
// betroffene Device bleibt dann wie zuvor leer) — best effort, kein
// zusätzlicher Fehlerpfad für den ohnehin schon dokumentiert unzuverlässigen
// Bulk-Endpunkt.
func (c *Client) fillSuspiciouslyEmptyDevices(ctx context.Context, views []NodeView, flowFormat map[string]string) {
	for ni := range views {
		for di := range views[ni].Devices {
			deviceID := views[ni].Devices[di].ID
			if hasSenderOrReceiverFor(views[ni], deviceID) {
				continue
			}

			var extraSenders []is04Sender
			if err := c.getJSON(ctx, "senders?device_id="+deviceID, &extraSenders); err == nil {
				for _, s := range extraSenders {
					format := ""
					if s.FlowID != nil {
						format = flowFormat[*s.FlowID]
					}
					views[ni].Senders = append(views[ni].Senders, SenderView{
						ID: s.ID, Label: s.Label, DeviceID: s.DeviceID, Format: format,
					})
				}
			}

			var extraReceivers []is04Receiver
			if err := c.getJSON(ctx, "receivers?device_id="+deviceID, &extraReceivers); err == nil {
				for _, r := range extraReceivers {
					views[ni].Receivers = append(views[ni].Receivers, ReceiverView{
						ID: r.ID, Label: r.Label, DeviceID: r.DeviceID, Format: r.Format,
					})
				}
			}
		}
	}
}

func hasSenderOrReceiverFor(view NodeView, deviceID string) bool {
	for _, s := range view.Senders {
		if s.DeviceID == deviceID {
			return true
		}
	}
	for _, r := range view.Receivers {
		if r.DeviceID == deviceID {
			return true
		}
	}
	return false
}

func (c *Client) getJSON(ctx context.Context, resource string, dst any) error {
	url := fmt.Sprintf("%s/x-nmos/query/v1.3/%s", c.baseURL, resource)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d from %s", resp.StatusCode, url)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// buildSnapshot ordnet die flachen IS-04-Listen den jeweiligen Nodes zu.
// Reines In-Memory-Mapping ohne weitere Registry-Aufrufe, daher unabhängig
// testbar (siehe client_test.go).
func buildSnapshot(nodes []is04Node, devices []is04Device, senders []is04Sender, receivers []is04Receiver, flows []is04Flow) []NodeView {
	flowFormat := make(map[string]string, len(flows))
	for _, f := range flows {
		flowFormat[f.ID] = f.Format
	}

	devicesByNode := make(map[string][]is04Device)
	for _, d := range devices {
		devicesByNode[d.NodeID] = append(devicesByNode[d.NodeID], d)
	}

	sendersByDevice := make(map[string][]is04Sender)
	for _, s := range senders {
		sendersByDevice[s.DeviceID] = append(sendersByDevice[s.DeviceID], s)
	}

	receiversByDevice := make(map[string][]is04Receiver)
	for _, r := range receivers {
		receiversByDevice[r.DeviceID] = append(receiversByDevice[r.DeviceID], r)
	}

	views := make([]NodeView, 0, len(nodes))
	for _, n := range nodes {
		view := NodeView{
			ID:         n.ID,
			Label:      n.Label,
			Online:     true, // Präsenz in der Registry == online; Expiry entfernt tote Nodes serverseitig (siehe registration_expiry_interval).
			Devices:    []DeviceView{},
			Senders:    []SenderView{},
			Receivers:  []ReceiverView{},
			APIBaseURL: apiBaseURL(n),
			InstanceID: instanceID(n),
		}

		for _, d := range devicesByNode[n.ID] {
			view.Devices = append(view.Devices, DeviceView{ID: d.ID, Label: d.Label})

			for _, s := range sendersByDevice[d.ID] {
				format := ""
				if s.FlowID != nil {
					format = flowFormat[*s.FlowID]
				}
				view.Senders = append(view.Senders, SenderView{
					ID:       s.ID,
					Label:    s.Label,
					DeviceID: s.DeviceID,
					Format:   format,
				})
			}

			for _, r := range receiversByDevice[d.ID] {
				view.Receivers = append(view.Receivers, ReceiverView{
					ID:       r.ID,
					Label:    r.Label,
					DeviceID: r.DeviceID,
					Format:   r.Format,
				})
			}
		}

		views = append(views, view)
	}

	return views
}

// apiBaseURL konstruiert die Basis-URL für das Node-eigene HTTP-API aus
// dem ersten IS-04-"api.endpoints"-Eintrag (Standardfeld jeder Node-
// Resource) — Grundlage für den generischen Parameter-/Methoden-Proxy
// (A8), ohne dass der Orchestrator etwas über den Node-Typ wüsste.
func apiBaseURL(n is04Node) string {
	if len(n.API.Endpoints) == 0 {
		return ""
	}
	ep := n.API.Endpoints[0]
	return fmt.Sprintf("%s://%s:%d", ep.Protocol, ep.Host, ep.Port)
}

// instanceTagName ist der IS-04-Tag-Name, den omp-node-sdk aus
// OMP_INSTANCE_ID setzt (UMSETZUNG.md C8, nodes/omp-node-sdk/src/is04.rs
// INSTANCE_TAG) — dieselbe Konstante lässt sich zwischen Go und Rust
// nicht teilen, daher hier als String-Literal dupliziert.
const instanceTagName = "urn:x-omp:instance"

// instanceID liest den ersten Wert von n.Tags["urn:x-omp:instance"],
// leer wenn der Tag fehlt (manuell gestartete Nodes, alle vor C8).
func instanceID(n is04Node) string {
	values := n.Tags[instanceTagName]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

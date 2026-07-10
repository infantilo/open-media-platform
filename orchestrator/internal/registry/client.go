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

	return buildSnapshot(nodes, devices, senders, receivers, flows), nil
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

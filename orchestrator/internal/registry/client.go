package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Client fragt die Standard-IS-04-Query-API einer NMOS-Registry ab. Er
// kennt keine nmos-cpp-Spezifika, nur die Standard-REST-Pfade
// (ARCHITECTURE.md §2/§5: "kein Orchestrator-Sonderwissen").
type Client struct {
	baseURL    string
	httpClient *http.Client

	// emptyChecked merkt sich Devices, deren gezielte Nachfrage (s.
	// fillSuspiciouslyEmptyDevices) leer blieb — Control-Plane-Nodes haben
	// dauerhaft weder Sender noch Receiver und wurden sonst in JEDEM Poll
	// mit zwei Zusatzrequests abgefragt.
	emptyMu      sync.Mutex
	emptyChecked map[string]time.Time
}

// emptyRecheckAfter: wie lange ein als leer bestätigtes Device nicht erneut
// gezielt abgefragt wird.
const emptyRecheckAfter = 10 * time.Second

// fetchParallelism begrenzt gleichzeitige Query-API-Requests je Poll.
const fetchParallelism = 8

// NewClient erstellt einen Client für die Query-API unter baseURL (z. B.
// "http://127.0.0.1:8010"), Version v1.3.
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

	var wg sync.WaitGroup
	errs := make(chan error, 5)
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
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.getJSON(ctx, f.path, f.dst); err != nil {
				errs <- fmt.Errorf("fetch %s: %w", f.path, err)
			}
		}()
	}
	// sources parallel zu den fünf Pflichtlisten (nicht fatal, s. u.).
	var sources []is04Source
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = c.getJSON(ctx, "sources", &sources)
	}()
	wg.Wait()
	close(errs)
	if err := <-errs; err != nil {
		return nil, err
	}

	flowFormat := make(map[string]string, len(flows))
	for _, fl := range flows {
		flowFormat[fl.ID] = fl.Format
	}

	// Kapitel 27 / P4: Audio-Kanalanzahl je Sender über Flow → Source. Nicht
	// fatal: ohne Sources bleibt ChannelCount 0 (nur abgeleitete Tags fehlen).
	views := buildSnapshot(nodes, devices, senders, receivers, flows)
	applyChannelCounts(views, flows, sources)

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
	type target struct{ ni, di int }
	type extra struct {
		senders   []is04Sender
		receivers []is04Receiver
		sOK, rOK  bool
	}

	now := time.Now()
	var targets []target
	present := map[string]bool{}
	c.emptyMu.Lock()
	for ni := range views {
		for di := range views[ni].Devices {
			deviceID := views[ni].Devices[di].ID
			present[deviceID] = true
			if hasSenderOrReceiverFor(views[ni], deviceID) {
				delete(c.emptyChecked, deviceID)
				continue
			}
			if at, ok := c.emptyChecked[deviceID]; ok && now.Sub(at) < emptyRecheckAfter {
				continue
			}
			targets = append(targets, target{ni, di})
		}
	}
	for id := range c.emptyChecked {
		if !present[id] {
			delete(c.emptyChecked, id)
		}
	}
	c.emptyMu.Unlock()
	if len(targets) == 0 {
		return
	}

	results := make([]extra, len(targets))
	sem := make(chan struct{}, fetchParallelism)
	var wg sync.WaitGroup
	for i, t := range targets {
		deviceID := views[t.ni].Devices[t.di].ID
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			r := &results[i]
			r.sOK = c.getJSON(ctx, "senders?device_id="+deviceID, &r.senders) == nil
			r.rOK = c.getJSON(ctx, "receivers?device_id="+deviceID, &r.receivers) == nil
		}()
	}
	wg.Wait()

	c.emptyMu.Lock()
	defer c.emptyMu.Unlock()
	if c.emptyChecked == nil {
		c.emptyChecked = map[string]time.Time{}
	}
	for i, t := range targets {
		deviceID := views[t.ni].Devices[t.di].ID
		r := results[i]
		for _, s := range r.senders {
			format := ""
			if s.FlowID != nil {
				format = flowFormat[*s.FlowID]
			}
			views[t.ni].Senders = append(views[t.ni].Senders, newSenderView(s, format))
		}
		for _, rc := range r.receivers {
			views[t.ni].Receivers = append(views[t.ni].Receivers, ReceiverView{
				ID: rc.ID, Label: rc.Label, DeviceID: rc.DeviceID, Format: rc.Format, Transport: rc.Transport, DiscoveredTags: rc.Tags[OMPTagsTag],
			})
		}
		if r.sOK && r.rOK && len(r.senders) == 0 && len(r.receivers) == 0 {
			c.emptyChecked[deviceID] = now
		} else {
			delete(c.emptyChecked, deviceID)
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

// getJSON liest eine IS-04-Query-Collection vollständig. Die Query-API
// pagniert (nmos-cpp-Default: paging.limit=10, live gefunden 2026-09-21:
// bei 12 Sendern lieferte eine einzelne Abfrage nur 10, welche zwei
// fehlten, wechselte von Abfrage zu Abfrage) — deshalb wird mit
// paging.limit=100 gefragt und dem `rel="next"`-Link bis zur leeren Seite
// gefolgt.
func (c *Client) getJSON(ctx context.Context, resource string, dst any) error {
	sep := "?"
	if strings.Contains(resource, "?") {
		sep = "&"
	}
	url := fmt.Sprintf("%s/x-nmos/query/v1.3/%s%spaging.limit=100", c.baseURL, resource, sep)
	var all []json.RawMessage
	for page := 0; url != "" && page < 1000; page++ {
		items, next, err := c.getPage(ctx, url)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			break
		}
		all = append(all, items...)
		url = next
	}
	// Seiten direkt zu einem JSON-Array zusammensetzen (statt die RawMessages
	// erst neu zu marshalen).
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, it := range all {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(it)
	}
	buf.WriteByte(']')
	return json.Unmarshal(buf.Bytes(), dst)
}

var linkNextRe = regexp.MustCompile(`<([^>]+)>\s*;\s*rel="next"`)

func (c *Client) getPage(ctx context.Context, url string) ([]json.RawMessage, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("unexpected status %d from %s", resp.StatusCode, url)
	}
	var items []json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return nil, "", err
	}
	next := ""
	if m := linkNextRe.FindStringSubmatch(resp.Header.Get("Link")); m != nil {
		next = m[1]
	}
	return items, next, nil
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
			Build:      buildInfo(n),
		}

		for _, d := range devicesByNode[n.ID] {
			view.Devices = append(view.Devices, DeviceView{ID: d.ID, Label: d.Label})

			for _, s := range sendersByDevice[d.ID] {
				format := ""
				if s.FlowID != nil {
					format = flowFormat[*s.FlowID]
				}
				view.Senders = append(view.Senders, newSenderView(s, format))
			}

			for _, r := range receiversByDevice[d.ID] {
				view.Receivers = append(view.Receivers, ReceiverView{
					ID:             r.ID,
					Label:          r.Label,
					DeviceID:       r.DeviceID,
					Format:         r.Format,
					Transport:      r.Transport,
					DiscoveredTags: r.Tags[OMPTagsTag],
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

// buildTagName: Gegenstück zu omp_node_sdk::buildinfo::BUILD_TAG.
const buildTagName = "urn:x-omp:build"

// buildInfo liest den Build-Stempel aus dem Tag (nil, wenn er fehlt).
func buildInfo(n is04Node) *BuildInfo {
	v := n.Tags[buildTagName]
	if len(v) == 0 || v[0] == "" {
		return nil
	}
	b := &BuildInfo{Version: v[0]}
	if len(v) > 1 {
		b.Commit = v[1]
	}
	if len(v) > 2 {
		b.BuiltAt = v[2]
	}
	if len(v) > 3 {
		if n, err := strconv.Atoi(v[3]); err == nil {
			b.Contract = n
		}
	}
	return b
}

// instanceID liest den ersten Wert von n.Tags["urn:x-omp:instance"],
// leer wenn der Tag fehlt (manuell gestartete Nodes, alle vor C8).
func instanceID(n is04Node) string {
	values := n.Tags[instanceTagName]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// newSenderView baut die normalisierte Sender-Sicht (gemeinsam für den
// Bulk-Pfad und die Device-gescopte Nachfrage).
func newSenderView(s is04Sender, format string) SenderView {
	v := SenderView{ID: s.ID, Label: s.Label, DeviceID: s.DeviceID, Format: format, Transport: s.Transport, GroupHint: s.groupHint(), DiscoveredTags: s.Tags[OMPTagsTag]}
	if s.FlowID != nil {
		v.FlowID = *s.FlowID
	}
	return v
}

// applyChannelCounts setzt SenderView.ChannelCount aus Flow → Source → channels.
func applyChannelCounts(views []NodeView, flows []is04Flow, sources []is04Source) {
	channelsBySource := make(map[string]int, len(sources))
	for _, s := range sources {
		channelsBySource[s.ID] = len(s.Channels)
	}
	sourceByFlow := make(map[string]string, len(flows))
	for _, f := range flows {
		sourceByFlow[f.ID] = f.SourceID
	}
	for ni := range views {
		for si := range views[ni].Senders {
			if fid := views[ni].Senders[si].FlowID; fid != "" {
				views[ni].Senders[si].ChannelCount = channelsBySource[sourceByFlow[fid]]
			}
		}
	}
}

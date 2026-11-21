package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	mcrmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/mcr"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// mcrNodes legt Registry und Node-HTTP-Client hinter die Node-Schnittstelle des MCR-Moduls (106.10).
type mcrNodes struct {
	nodes interface{ List() []registry.NodeView }
	http  *http.Client
}

func (m mcrNodes) BaseURL(instanceID string) (string, bool) {
	for _, n := range m.nodes.List() {
		if n.InstanceID == instanceID && n.Online && n.APIBaseURL != "" {
			return n.APIBaseURL, true
		}
	}
	return "", false
}

func (m mcrNodes) Do(ctx context.Context, method, url string, body any) ([]byte, int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return b, resp.StatusCode, nil
}

// mcrSecretsDir: Verzeichnis der Passphrase-Dateien (Rechte 0600), je Leitung über den Schlüsselnamen aus der Datenbank gewählt.
func mcrSecretsDir() string { return os.Getenv("OMP_MCR_SECRETS_DIR") }

// mcrFabric verbindet Sender und Empfänger über den Kern-Graphen und findet sie über die Registry (106.12).
type mcrFabric struct {
	nodes interface{ List() []registry.NodeView }
	graph interface {
		Connect(ctx context.Context, fromSender, toReceiver string) error
	}
}

const mcrFormatAudio = "urn:x-nmos:format:audio"

func (f mcrFabric) node(instanceID string) (registry.NodeView, bool) {
	for _, n := range f.nodes.List() {
		if n.InstanceID == instanceID && n.Online {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (f mcrFabric) AudioSender(instanceID, hint string) (string, bool) {
	n, ok := f.node(instanceID)
	if !ok {
		return "", false
	}
	first := ""
	for _, s := range n.Senders {
		if s.Format != mcrFormatAudio {
			continue
		}
		if hint != "" && strings.Contains(s.Label, hint) {
			return s.ID, true
		}
		if first == "" {
			first = s.ID
		}
	}
	if hint != "" {
		return "", false
	}
	return first, first != ""
}

func (f mcrFabric) AudioReceiver(instanceID string) (string, bool) {
	n, ok := f.node(instanceID)
	if !ok {
		return "", false
	}
	for _, r := range n.Receivers {
		if r.Format == mcrFormatAudio {
			return r.ID, true
		}
	}
	return "", false
}

func (f mcrFabric) IntercomReceiver(slot int) (string, bool) {
	want := fmt.Sprintf("Programm %d", slot)
	for _, n := range f.nodes.List() {
		if !n.Online {
			continue
		}
		for _, r := range n.Receivers {
			if strings.HasSuffix(r.Label, want) {
				return r.ID, true
			}
		}
	}
	return "", false
}

func (f mcrFabric) IntercomSender(slot int) (string, bool) {
	want := fmt.Sprintf("Intercom Mix %d", slot)
	for _, n := range f.nodes.List() {
		if !n.Online {
			continue
		}
		for _, s := range n.Senders {
			if strings.HasSuffix(s.Label, want) {
				return s.ID, true
			}
		}
	}
	return "", false
}

func (f mcrFabric) Connect(ctx context.Context, fromSender, toReceiver string) error {
	return f.graph.Connect(ctx, fromSender, toReceiver)
}

const mcrFormatVideo = "urn:x-nmos:format:video"

const mcrFormatData = "urn:x-nmos:format:data"

// Link verbindet Bild-, Ton- und Datensender vorhandener Nodes mit dem Normalizer (106.x „vorhandene Quelle“). Bild, Ton und
// Daten dürfen aus verschiedenen Nodes kommen (Existing.VideoNodeID/AudioNodeID/DataNodeID, sonst NodeID).
func (f mcrFabric) Link(ctx context.Context, src mcrmod.Existing, videoInstance, audioInstance string) error {
	normV, ok := f.node(videoInstance)
	if !ok {
		return fmt.Errorf("Instanz %s ist nicht online", videoInstance)
	}
	normA, ok := f.node(audioInstance)
	if !ok {
		return fmt.Errorf("Instanz %s ist nicht online", audioInstance)
	}
	online := f.nodes.List()
	// findNode sucht den Node einer Art: nach ID, nach Sender-ID, sonst nach Bezeichnung.
	findNode := func(id, label, sender string) (registry.NodeView, bool) {
		for _, n := range online {
			if !n.Online {
				continue
			}
			if id != "" && n.ID == id {
				return n, true
			}
			if sender != "" {
				for _, s := range n.Senders {
					if s.ID == sender {
						return n, true
					}
				}
			}
		}
		if id == "" && sender == "" && label != "" {
			for _, n := range online {
				if n.Online && n.Label == label {
					return n, true
				}
			}
		}
		return registry.NodeView{}, false
	}
	pick := func(n registry.NodeView, wanted, format string) string {
		first := ""
		for _, s := range n.Senders {
			if wanted != "" && s.ID == wanted {
				return s.ID
			}
			if first == "" && s.Format == format {
				first = s.ID
			}
		}
		if wanted != "" {
			return ""
		}
		return first
	}
	recv := func(format string) string {
		norm := normV // Bild und Daten: erstes Glied der Kette, das Bild annimmt
		if format == mcrFormatAudio {
			norm = normA
		}
		for _, r := range norm.Receivers {
			if r.Format == format {
				return r.ID
			}
		}
		return ""
	}
	type part struct {
		name, nodeID, nodeLabel, sender, format string
		wanted                                  bool
	}
	first := func(a, b string) string {
		if a != "" {
			return a
		}
		return b
	}
	// Eine Art ist gewählt, wenn ein eigener Node/Sender genannt ist oder (ältere Form) die gemeinsame Quelle gilt.
	shared := src.NodeID != "" || src.NodeLabel != ""
	parts := []part{
		{"Bild", first(src.VideoNodeID, src.NodeID), first(src.VideoNodeLabel, src.NodeLabel), src.VideoSenderID, mcrFormatVideo, src.VideoNodeID != "" || src.VideoSenderID != "" || shared},
		{"Ton", first(src.AudioNodeID, src.NodeID), first(src.AudioNodeLabel, src.NodeLabel), src.AudioSenderID, mcrFormatAudio, src.AudioNodeID != "" || src.AudioSenderID != "" || shared},
		{"Daten", src.DataNodeID, src.DataNodeLabel, src.DataSenderID, mcrFormatData, src.DataNodeID != "" || src.DataSenderID != ""},
	}
	linked := 0
	var missing []string
	for _, p := range parts {
		if !p.wanted {
			continue
		}
		n, found := findNode(p.nodeID, p.nodeLabel, p.sender)
		if !found {
			missing = append(missing, fmt.Sprintf("%s: Quelle „%s“ ist nicht online", p.name, first(p.nodeLabel, p.nodeID)))
			continue
		}
		from, to := pick(n, p.sender, p.format), recv(p.format)
		if from == "" || to == "" {
			continue
		}
		if err := f.graph.Connect(ctx, from, to); err != nil {
			return err
		}
		linked++
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s", strings.Join(missing, "; "))
	}
	if linked == 0 {
		return fmt.Errorf("die Quellen haben keinen zum Normalizer passenden Bild-, Ton- oder Datensender")
	}
	return nil
}

// VideoSender: Bild-Sender einer Instanz (Normalizer-Ausgang für die Kachel im Multiviewer).
func (f mcrFabric) VideoSender(instanceID string) (string, bool) {
	n, ok := f.node(instanceID)
	if !ok {
		return "", false
	}
	for _, s := range n.Senders {
		if s.Format == mcrFormatVideo {
			return s.ID, true
		}
	}
	return "", false
}

// LinkInstances verbindet Bild- und Tonsender der ersten mit den passenden Empfängern der zweiten Instanz (Überwachung).
func (f mcrFabric) LinkInstances(ctx context.Context, fromVideo, fromAudio, toInstance string) error {
	to, ok := f.node(toInstance)
	if !ok {
		return fmt.Errorf("Instanz %s ist nicht online", toInstance)
	}
	linked := 0
	for _, format := range []string{mcrFormatVideo, mcrFormatAudio} {
		fromInstance := fromVideo // Bild und Ton können aus verschiedenen Gliedern der Kette kommen
		if format == mcrFormatAudio {
			fromInstance = fromAudio
		}
		from, ok := f.node(fromInstance)
		if !ok {
			continue
		}
		s, r := "", ""
		for _, x := range from.Senders {
			if x.Format == format {
				s = x.ID
				break
			}
		}
		for _, x := range to.Receivers {
			if x.Format == format {
				r = x.ID
				break
			}
		}
		if s == "" || r == "" {
			continue
		}
		if err := f.graph.Connect(ctx, s, r); err != nil {
			return err
		}
		linked++
	}
	if linked == 0 {
		return fmt.Errorf("kein passendes Sender-/Empfängerpaar zu Instanz %s", toInstance)
	}
	return nil
}

// NodeID: IS-04-Node-ID der Instanz (Vorschau-Stream und Bedienoberfläche liegen unter /api/v1/nodes/<id>).
func (f mcrFabric) NodeID(instanceID string) (string, bool) {
	n, ok := f.node(instanceID)
	if !ok {
		return "", false
	}
	return n.ID, true
}

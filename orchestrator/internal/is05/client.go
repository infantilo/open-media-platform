// Package is05 spricht die Standard-IS-05-Connection-API einzelner Nodes
// an (nicht die Registry — IS-05 läuft node-zu-node/controller-zu-node,
// ohne zentrale Instanz). Feldnamen geprüft gegen AMWA-TV/is-05 (Branch
// v1.1.x, APIs/schemas/receiver-*.json, sender-stage-schema.json,
// activation-schema.json). Die Aufrufer geben die versionierte Wurzel
// mit (registry.NodeView.ConnectionAPI): die Version, die das Device in
// seinen IS-04-"controls" meldet (v1.2 bevorzugt), ohne Meldung v1.2 wie bisher
// (Nachtrag 191). Die Bodies sind in v1.1 und v1.2 gleich (Nachtrag 189).
package is05

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// ActiveResource ist die für den Graph-Endpunkt relevante Teilmenge des
// IS-05-Receiver-Resource (receiver-response-schema.json).
type ActiveResource struct {
	SenderID     *string `json:"sender_id"`
	MasterEnable bool    `json:"master_enable"`
}

// Client PATCHt/liest die Connection-API einzelner Receiver.
type Client struct {
	httpClient *http.Client
}

// NewClient erstellt einen IS-05-Client. httpClient darf nil sein
// (http.DefaultClient wird dann verwendet).
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{httpClient: httpClient}
}

// GetActive liest den active-Zustand eines Receivers.
func (c *Client) GetActive(ctx context.Context, connectionAPI, receiverID string) (ActiveResource, error) {
	url := fmt.Sprintf("%s/single/receivers/%s/active", connectionAPI, receiverID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ActiveResource{}, err
	}
	// ARCHITECTURE.md §25.1: trägt einen laufenden Trace weiter (oder
	// beginnt einen neuen), damit ein fehlschlagender IS-05-Aufruf im
	// Diagnose-Cockpit mit dem auslösenden Vorgang korreliert werden kann.
	tracing.SetHeaders(req, ctx)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ActiveResource{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ActiveResource{}, fmt.Errorf("is05: unexpected status %d from %s", resp.StatusCode, url)
	}

	var res ActiveResource
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return ActiveResource{}, err
	}
	return res, nil
}

// PatchStaged verbindet (senderID != nil) oder trennt (senderID == nil)
// einen Receiver, mit sofortiger Aktivierung
// (activation.mode = "activate_immediate").
func (c *Client) PatchStaged(ctx context.Context, connectionAPI, receiverID string, senderID *string, masterEnable bool) error {
	url := fmt.Sprintf("%s/single/receivers/%s/staged", connectionAPI, receiverID)

	body, err := json.Marshal(map[string]any{
		"sender_id":     senderID,
		"master_enable": masterEnable,
		"activation":    map[string]any{"mode": "activate_immediate"},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	tracing.SetHeaders(req, ctx)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("is05: unexpected status %d from PATCH %s", resp.StatusCode, url)
	}
	return nil
}

// PatchSenderStaged schaltet den Ausgang eines Senders ein/aus
// (master_enable), mit sofortiger Aktivierung. Die Ziel-Adresse
// (transport_params.destination_ip/_port) bleibt hier unangetastet — das
// ist node-eigene Konfiguration (UMSETZUNG.md C3, docs/decisions.md);
// dieser Aufruf steuert bewusst nur Start/Stop, nicht das Ziel. Nicht
// jeder Node implementiert eine eigene Sender-Connection-API (z. B. der
// Mock-Node, der nur Receiver-seitig antwortet, Schritt A7/B1) — Aufrufer
// behandeln einen Fehler hier als nicht fatal.
func (c *Client) PatchSenderStaged(ctx context.Context, connectionAPI, senderID string, masterEnable bool) error {
	url := fmt.Sprintf("%s/single/senders/%s/staged", connectionAPI, senderID)

	body, err := json.Marshal(map[string]any{
		"master_enable": masterEnable,
		"activation":    map[string]any{"mode": "activate_immediate"},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	tracing.SetHeaders(req, ctx)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("is05: unexpected status %d from PATCH %s", resp.StatusCode, url)
	}
	return nil
}

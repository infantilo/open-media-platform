// Package is05 spricht die Standard-IS-05-Connection-API einzelner Nodes
// an (nicht die Registry — IS-05 läuft node-zu-node/controller-zu-node,
// ohne zentrale Instanz). Feldnamen geprüft gegen AMWA-TV/is-05 (Branch
// v1.1.x, APIs/schemas/receiver-*.json, activation-schema.json).
package is05

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
func (c *Client) GetActive(ctx context.Context, baseURL, receiverID string) (ActiveResource, error) {
	url := fmt.Sprintf("%s/x-nmos/connection/v1.1/single/receivers/%s/active", baseURL, receiverID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ActiveResource{}, err
	}

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
func (c *Client) PatchStaged(ctx context.Context, baseURL, receiverID string, senderID *string, masterEnable bool) error {
	url := fmt.Sprintf("%s/x-nmos/connection/v1.1/single/receivers/%s/staged", baseURL, receiverID)

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

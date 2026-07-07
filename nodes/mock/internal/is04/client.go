package is04

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// ErrNotRegistered wird von Heartbeat zurückgegeben, wenn die Registry die
// Node-Resource nicht (mehr) kennt (HTTP 404) — z. B. nach einem
// Registry-Neustart. Der Aufrufer sollte in diesem Fall neu registrieren.
var ErrNotRegistered = errors.New("is04: node not registered (404)")

// Client registriert Resources an einer Standard-IS-04-Registration-API
// (v1.3) und schickt Heartbeats.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient erstellt einen Registration-API-Client für baseURL (z. B.
// "http://localhost:8010").
func NewClient(baseURL string) *Client {
	return &Client{baseURL: baseURL, http: http.DefaultClient}
}

// Register meldet eine Resource vom angegebenen Typ ("node", "device",
// "sender", "receiver") an. Akzeptiert sowohl 200 (Update) als auch 201
// (Created) als Erfolg, wie von der IS-04-Registration-API spezifiziert.
func (c *Client) Register(ctx context.Context, resourceType string, data any) error {
	body, err := json.Marshal(map[string]any{"type": resourceType, "data": data})
	if err != nil {
		return fmt.Errorf("marshal %s: %w", resourceType, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/x-nmos/registration/v1.3/resource", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("register %s: %w", resourceType, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("register %s: unexpected status %d", resourceType, resp.StatusCode)
	}
	return nil
}

// Heartbeat hält eine registrierte Node am Leben (POST
// .../health/nodes/<id>, muss innerhalb von registration_expiry_interval
// wiederholt werden). Liefert ErrNotRegistered bei HTTP 404.
func (c *Client) Heartbeat(ctx context.Context, nodeID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/x-nmos/registration/v1.3/health/nodes/"+nodeID, nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ErrNotRegistered
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat: unexpected status %d", resp.StatusCode)
	}
	return nil
}

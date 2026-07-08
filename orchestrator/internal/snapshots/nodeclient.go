package snapshots

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// descriptorParam ist die für Snapshots relevante Teilmenge eines
// Descriptor-Parameters (docs/descriptor-v0.schema.json, Schritt A8).
type descriptorParam struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"readonly"`
}

type descriptorResponse struct {
	Parameters []descriptorParam `json:"parameters"`
}

// nodeClient ist die von Service genutzte Teilmenge eines Node-HTTP-
// Clients — als Interface gehalten, damit Service-Tests ohne echte
// HTTP-Aufrufe an Mock-Nodes auskommen.
type nodeClient interface {
	GetWritableParams(ctx context.Context, baseURL string) ([]string, error)
	GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error)
	PatchParam(ctx context.Context, baseURL, name string, value json.RawMessage) error
}

// httpNodeClient spricht direkt mit dem Self-Describe-HTTP-API eines
// Nodes (descriptor.json, params/<name>) — dieselben Standard-Pfade, die
// auch der generische Orchestrator-Proxy aus A8 verwendet.
type httpNodeClient struct {
	httpClient *http.Client
}

func newHTTPNodeClient() *httpNodeClient {
	return &httpNodeClient{httpClient: http.DefaultClient}
}

// GetWritableParams liefert die Namen aller nicht schreibgeschützten
// Parameter aus dem Descriptor des Nodes.
func (c *httpNodeClient) GetWritableParams(ctx context.Context, baseURL string) ([]string, error) {
	var resp descriptorResponse
	if err := c.getJSON(ctx, baseURL+"/descriptor.json", &resp); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(resp.Parameters))
	for _, p := range resp.Parameters {
		if !p.ReadOnly {
			names = append(names, p.Name)
		}
	}
	return names, nil
}

// GetParam liefert den aktuellen Wert eines Parameters.
func (c *httpNodeClient) GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error) {
	var body struct {
		Value json.RawMessage `json:"value"`
	}
	if err := c.getJSON(ctx, baseURL+"/params/"+name, &body); err != nil {
		return nil, err
	}
	return body.Value, nil
}

// PatchParam setzt den Wert eines Parameters.
func (c *httpNodeClient) PatchParam(ctx context.Context, baseURL, name string, value json.RawMessage) error {
	payload, err := json.Marshal(struct {
		Value json.RawMessage `json:"value"`
	}{Value: value})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, baseURL+"/params/"+name, bytes.NewReader(payload))
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
		return fmt.Errorf("snapshots: unexpected status %d from PATCH %s/params/%s", resp.StatusCode, baseURL, name)
	}
	return nil
}

func (c *httpNodeClient) getJSON(ctx context.Context, url string, dst any) error {
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
		return fmt.Errorf("snapshots: unexpected status %d from %s", resp.StatusCode, url)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

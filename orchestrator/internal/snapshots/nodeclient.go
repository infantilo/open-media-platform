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
	// GetState/ApplyState sprechen die optionale Node-Contract-
	// Erweiterung `GET`/`POST /state` an (docs/decisions.md Nachtrag 40,
	// ARCHITECTURE.md §5): manche Nodes (omp-audio-mixer,
	// omp-video-mixer-me) erklären ausnahmslos alle Parameter
	// `readonly:true` (Mutation nur über eigene invoke()-Methoden) —
	// für sie liefert die Parameter-Enumeration unten nichts. `ok==false`
	// (kein Fehler, reines 404) bedeutet "Node unterstützt das nicht",
	// Aufrufer fällt dann auf die generische Parametererfassung zurück.
	GetState(ctx context.Context, baseURL string) (state json.RawMessage, ok bool, err error)
	ApplyState(ctx context.Context, baseURL string, state json.RawMessage) (ok bool, err error)
}

// httpNodeClient spricht direkt mit dem Self-Describe-HTTP-API eines
// Nodes (descriptor.json, params/<name>) — dieselben Standard-Pfade, die
// auch der generische Orchestrator-Proxy aus A8 verwendet.
type httpNodeClient struct {
	httpClient *http.Client
}

// newHTTPNodeClient erstellt einen Client für die Node-Aufrufe. httpClient
// darf nil sein (http.DefaultClient wird dann verwendet) — Aufrufer
// übergibt hier den ggf. mTLS-fähigen Client (UMSETZUNG.md D3), damit
// Create/Apply dieselbe Client-Authentifizierung wie der generische
// Node-Proxy verwenden.
func newHTTPNodeClient(httpClient *http.Client) *httpNodeClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &httpNodeClient{httpClient: httpClient}
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

// GetState ruft `GET <baseURL>/state` ab. Ein 404 ist kein Fehler — der
// Node bietet die Zusatzroute schlicht nicht an (Standardfall für alle
// Nodes mit ausschließlich schreibbaren Parametern).
func (c *httpNodeClient) GetState(ctx context.Context, baseURL string) (json.RawMessage, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/state", nil)
	if err != nil {
		return nil, false, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("snapshots: unexpected status %d from GET %s/state", resp.StatusCode, baseURL)
	}

	var body struct {
		State json.RawMessage `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, false, err
	}
	return body.State, true, nil
}

// ApplyState ruft `POST <baseURL>/state` mit `{"state": ...}` auf. Wie
// GetState: ein 404 ist kein Fehler, sondern "Node unterstützt das
// nicht" — der Aufrufer entscheidet dann, ob Params stattdessen
// gepatcht werden.
func (c *httpNodeClient) ApplyState(ctx context.Context, baseURL string, state json.RawMessage) (bool, error) {
	payload, err := json.Marshal(struct {
		State json.RawMessage `json:"state"`
	}{State: state})
	if err != nil {
		return false, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/state", bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("snapshots: unexpected status %d from POST %s/state", resp.StatusCode, baseURL)
	}
	return true, nil
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

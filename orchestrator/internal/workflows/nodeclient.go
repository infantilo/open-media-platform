package workflows

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// methodInvoker ruft eine Node-eigene Methode auf (POST /methods/<name>,
// UMSETZUNG.md A8/C4-prep) und liest Node-Parameter (GET /params/<name>)
// — gebraucht, um eine Workflow-Connection auf eine Crosspoint-Zielrolle
// aufzulösen (s. Connection-Doku in types.go), statt eines IS-05
// Connect. GetParam wird gebraucht, um vor dem eigentlichen
// Methodenaufruf abzuwarten, bis die Zielrolle den gewählten Sender
// selbst entdeckt hat (s. waitForCrosspointInput in service.go — sonst
// verwirft z. B. omp-video-mixer-me die Auswahl kommentarlos, live
// gefunden 2026-07-18). Als Interface gehalten, damit Service-Tests ohne
// echte HTTP-Aufrufe an Mock-Nodes auskommen (gleiches Muster wie
// snapshots.nodeClient).
type methodInvoker interface {
	Invoke(ctx context.Context, baseURL, method string, args map[string]any) error
	GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error)
}

// httpMethodInvoker spricht direkt mit dem Self-Describe-HTTP-API eines
// Nodes — derselbe Standard-Pfad, den auch der generische
// Orchestrator-Proxy (httpapi.handleNodeProxy) verwendet.
type httpMethodInvoker struct {
	httpClient *http.Client
}

// newHTTPMethodInvoker erstellt einen Invoker. httpClient darf nil sein
// (http.DefaultClient wird dann verwendet) — Aufrufer übergibt hier den
// ggf. mTLS-fähigen Client (UMSETZUNG.md D3), damit Workflow-Crosspoint-
// Aufrufe dieselbe Client-Authentifizierung wie der generische
// Node-Proxy und snapshots.Service verwenden.
func newHTTPMethodInvoker(httpClient *http.Client) *httpMethodInvoker {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &httpMethodInvoker{httpClient: httpClient}
}

// Invoke ruft <baseURL>/methods/<method> mit args als JSON-Objekt-Body
// auf (nicht in {"value": ...} verpackt — anders als PATCH /params/<name>,
// s. omp-node-sdk/src/server.rs route()).
func (c *httpMethodInvoker) Invoke(ctx context.Context, baseURL, method string, args map[string]any) error {
	payload, err := json.Marshal(args)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/methods/"+method, bytes.NewReader(payload))
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
		return fmt.Errorf("workflows: unexpected status %d from POST %s/methods/%s", resp.StatusCode, baseURL, method)
	}
	return nil
}

// GetParam liefert den aktuellen Wert eines Parameters (gleiches
// {"value": ...}-Antwortformat wie snapshots.httpNodeClient.GetParam,
// s. omp-node-sdk/src/server.rs route()).
func (c *httpMethodInvoker) GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/params/"+name, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("workflows: unexpected status %d from GET %s/params/%s", resp.StatusCode, baseURL, name)
	}
	var body struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Value, nil
}

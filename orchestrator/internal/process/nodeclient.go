package process

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// NodeResolver löst eine STABILE Instanz-ID (registry.NodeView.InstanceID,
// launcher-vergeben, überlebt einen Node-Neustart — anders als die
// flüchtige NMOS-Node-ID) auf die aktuell erreichbare Basis-URL des
// dahinterstehenden Prozesses auf. Als Interface gehalten (statt direkt
// *registry.Store zu verlangen), damit Tests ohne echte Registry
// auskommen — gleiches Muster wie internal/workflows.methodInvoker.
type NodeResolver interface {
	ResolveAPIBaseURL(instanceID string) (baseURL string, ok bool)
}

// RegistryNodeResolver ist der reale NodeResolver für main.go (Phase 5) —
// wrappt den bereits vorhandenen NMOS-Registry-Store (Infrastructure-
// Domain, s. UMSETZUNG.md §6b/21.2 Domain-Trennung: internal/process
// darf internal/registry importieren, das ist Infrastruktur, kein
// Zyklus).
type RegistryNodeResolver struct {
	store *registry.Store
}

// NewRegistryNodeResolver erstellt einen RegistryNodeResolver.
func NewRegistryNodeResolver(store *registry.Store) *RegistryNodeResolver {
	return &RegistryNodeResolver{store: store}
}

func (r *RegistryNodeResolver) ResolveAPIBaseURL(instanceID string) (string, bool) {
	node, ok := r.store.GetByInstanceID(instanceID)
	if !ok || node.APIBaseURL == "" {
		return "", false
	}
	return node.APIBaseURL, true
}

// methodInvoker ruft <baseURL>/methods/<name> auf (POST, JSON-Objekt-
// Body als Argumente) — derselbe Standard-Node-Contract-Pfad wie
// internal/workflows.httpMethodInvoker (nodes/omp-node-sdk/src/server.rs
// route()), hier unabhängig dupliziert statt importiert: internal/process
// bleibt bewusst von internal/workflows entkoppelt (UMSETZUNG.md
// §6b/21.2 — getrennte Domänen trotz ähnlicher Aufgabe), beide Pakete
// sprechen nur unabhängig denselben Node-HTTP-Standard.
type methodInvoker interface {
	Invoke(ctx context.Context, baseURL, method string, args json.RawMessage) (json.RawMessage, error)
}

type httpMethodInvoker struct {
	httpClient *http.Client
}

func newHTTPMethodInvoker(httpClient *http.Client) *httpMethodInvoker {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &httpMethodInvoker{httpClient: httpClient}
}

// Invoke ruft die Methode auf und liefert die Antwort roh zurück (z. B.
// `{"ok":true}` bei Erfolg, s. server.rs route()) — der Aufrufer
// (executors.go) entscheidet, was davon als Step-Output relevant ist.
func (c *httpMethodInvoker) Invoke(ctx context.Context, baseURL, method string, args json.RawMessage) (json.RawMessage, error) {
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/methods/"+method, bytes.NewReader(args))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var body json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		body = json.RawMessage(`{}`)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("process: unexpected status %d from POST %s/methods/%s: %s", resp.StatusCode, baseURL, method, body)
	}
	return body, nil
}

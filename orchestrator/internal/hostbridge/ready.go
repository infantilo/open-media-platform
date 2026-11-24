package hostbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// FabricsReady prüft nach der Registrierung eines Gliedes, ob ein Fabrics-Ziel seine Adresse bekannt gegeben hat
// (Parameter fabricsTargetInfo; leer = Endpunkt nicht gebunden, z. B. keine libfabric). Andere Glieder haben den
// Parameter nicht (404) und gelten mit der Registrierung als bereit. client trägt Token/mTLS wie im übrigen Orchestrator.
func FabricsReady(client *http.Client) func(ctx context.Context, n registry.NodeView, role string) error {
	if client == nil {
		client = http.DefaultClient
	}
	return func(ctx context.Context, n registry.NodeView, role string) error {
		if n.APIBaseURL == "" {
			return nil
		}
		for {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.APIBaseURL+"/params/fabricsTargetInfo", nil)
			if err != nil {
				return err
			}
			resp, err := client.Do(req)
			if err == nil {
				var out struct {
					Value string `json:"value"`
				}
				code := resp.StatusCode
				derr := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out)
				resp.Body.Close()
				if code == http.StatusNotFound {
					return nil
				}
				if code == http.StatusOK && derr == nil && out.Value != "" {
					return nil
				}
			}
			select {
			case <-ctx.Done():
				return fmt.Errorf("fabrics target did not publish an address: %w", ctx.Err())
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
}

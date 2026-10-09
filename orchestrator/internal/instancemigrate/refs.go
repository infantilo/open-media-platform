package instancemigrate

// Referenzen anderer Nodes auf die migrierte Instanz mitführen (Nutzerfund 2026-10-09:
// "beim Verschieben der Quelle TEST2 hat der Video-Mixer die Quelle verloren").
//
// Ein Umzug/Neustart einer eigenständigen Instanz vergibt neue Sender- und Node-IDs. Mischer
// merken sich ihre Quellen aber über genau diese IDs (Kreuzschiene, Pinnings, PiP-Presets) —
// nach dem Umzug zeigten sie ins Leere. Wie bei Workflow-Rollen (workflows/state.go) werden
// deshalb vor dem Stop die /state-Blobs aller anderen Nodes erfasst, die eine alte ID
// enthalten, die IDs gegen stabile Aliasse (Port-Index) getauscht und nach der
// Registrierung der neuen Instanz gegen deren neue IDs aufgelöst zurückgespielt.
// Zusätzlich wandern die schreibbaren Parameter der migrierten Instanz selbst mit
// (z. B. das Testbild einer Quelle).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

const (
	aliasSenderPrefix = "@@omp-migrate-sender:"
	aliasNodePrefix   = "@@omp-migrate-node"
	maxStateBytes     = 1 << 20
	callTimeout       = 3 * time.Second
)

// restoreRetries/restoreRetryDelay: wie workflows.restoreStateRetries — ein Mischer löst die
// neue Quelle erst auf, wenn Registry und MXL-Flow sichtbar sind.
var (
	restoreRetries    = 8
	restoreRetryDelay = 2 * time.Second
)

type consumerState struct {
	apiBaseURL string
	aliased    json.RawMessage
}

type carried struct {
	consumers []consumerState
	ownParams map[string]json.RawMessage
}

func (s *Service) client() *http.Client {
	if s.httpClient != nil {
		return s.httpClient
	}
	return http.DefaultClient
}

// captureCarried liest (VOR dem Stop) die Referenzen anderer Nodes und die eigenen Parameter.
func (s *Service) captureCarried(oldNode registry.NodeView) carried {
	var c carried
	toAlias := map[string]string{oldNode.ID: aliasNodePrefix}
	for i, sn := range oldNode.Senders {
		toAlias[sn.ID] = fmt.Sprintf("%s%d", aliasSenderPrefix, i)
	}
	for _, n := range s.nodes.List() {
		if n.ID == oldNode.ID || n.APIBaseURL == "" {
			continue
		}
		raw, err := getJSON(s.client(), n.APIBaseURL+"/state")
		if err != nil {
			continue // Node ohne /state
		}
		references := false
		for id := range toAlias {
			if strings.Contains(string(raw), id) {
				references = true
				break
			}
		}
		if !references {
			continue
		}
		aliased, err := mapStrings(raw, toAlias)
		if err != nil {
			continue
		}
		c.consumers = append(c.consumers, consumerState{apiBaseURL: n.APIBaseURL, aliased: aliased})
	}
	if oldNode.APIBaseURL != "" {
		c.ownParams = s.captureParams(oldNode.APIBaseURL)
	}
	return c
}

// restoreCarried spielt Parameter und Referenzen gegen die IDs der neuen Instanz zurück.
func (s *Service) restoreCarried(c carried, newNode registry.NodeView) {
	if newNode.APIBaseURL != "" {
		for name, value := range c.ownParams {
			if err := s.patchParam(newNode.APIBaseURL, name, value); err != nil {
				slog.Warn("instancemigrate: Parameter nicht übertragen", "param", name, "error", err)
			}
		}
	}
	fromAlias := map[string]string{aliasNodePrefix: newNode.ID}
	for i, sn := range newNode.Senders {
		fromAlias[fmt.Sprintf("%s%d", aliasSenderPrefix, i)] = sn.ID
	}
	for _, cs := range c.consumers {
		resolved, err := mapStrings(cs.aliased, fromAlias)
		if err != nil {
			continue
		}
		if err := s.postStateVerified(cs.apiBaseURL, resolved); err != nil {
			slog.Warn("instancemigrate: Referenzen im Nachbar-Node nicht wiederhergestellt", "node", cs.apiBaseURL, "error", err)
		}
	}
}

func (s *Service) postStateVerified(apiBaseURL string, state json.RawMessage) error {
	var lastErr error
	for attempt := 1; attempt <= restoreRetries; attempt++ {
		if attempt > 1 {
			time.Sleep(restoreRetryDelay)
		}
		if err := s.send(http.MethodPost, apiBaseURL+"/state", state); err != nil {
			lastErr = err
			continue
		}
		time.Sleep(200 * time.Millisecond)
		after, err := getJSON(s.client(), apiBaseURL+"/state")
		if err != nil {
			lastErr = err
			continue
		}
		if jsonEqual(after, state) {
			return nil
		}
		lastErr = fmt.Errorf("zurückgelesener Zustand weicht ab (Registry-/Flow-Verzögerung)")
	}
	return lastErr
}

func (s *Service) captureParams(apiBaseURL string) map[string]json.RawMessage {
	raw, err := getJSON(s.client(), apiBaseURL+"/descriptor.json")
	if err != nil {
		return nil
	}
	var d struct {
		Parameters []struct {
			Name     string `json:"name"`
			ReadOnly bool   `json:"readonly"`
		} `json:"parameters"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil
	}
	out := map[string]json.RawMessage{}
	for _, p := range d.Parameters {
		if p.ReadOnly {
			continue
		}
		v, err := getJSON(s.client(), apiBaseURL+"/params/"+p.Name)
		if err != nil {
			continue
		}
		var body struct {
			Value json.RawMessage `json:"value"`
		}
		if json.Unmarshal(v, &body) == nil && len(body.Value) > 0 {
			out[p.Name] = body.Value
		}
	}
	return out
}

func (s *Service) patchParam(apiBaseURL, name string, value json.RawMessage) error {
	payload, _ := json.Marshal(struct {
		Value json.RawMessage `json:"value"`
	}{value})
	return s.send(http.MethodPatch, apiBaseURL+"/params/"+name, payload)
}

func (s *Service) send(method, url string, body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s %s: status %d", method, url, resp.StatusCode)
	}
	return nil
}

func getJSON(client *http.Client, url string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxStateBytes))
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("GET %s: kein gültiges JSON", url)
	}
	return body, nil
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y interface{}
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

// mapStrings ersetzt rekursiv jeden String-Wert, der in lookup vorkommt (schemafrei).
func mapStrings(raw json.RawMessage, lookup map[string]string) (json.RawMessage, error) {
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.Marshal(substitute(v, lookup))
}

func substitute(v interface{}, lookup map[string]string) interface{} {
	switch val := v.(type) {
	case string:
		if r, ok := lookup[val]; ok {
			return r
		}
		return val
	case []interface{}:
		out := make([]interface{}, len(val))
		for i, e := range val {
			out[i] = substitute(e, lookup)
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(val))
		for k, e := range val {
			out[k] = substitute(e, lookup)
		}
		return out
	default:
		return val
	}
}

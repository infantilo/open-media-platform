// Package orch spricht den Orchestrator wie jeder Control-Plane-Node: mit
// einem Service-Token (OMP_LAUNCH_SECRET) über den Proxy, nie direkt am Node
// vorbei (ARCHITECTURE.md §24.1) — Rechte und Audit gelten unverändert.
package orch

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	base, instanceID, secret string
	http                     *http.Client
	mu                       sync.Mutex
	token                    string
	fetched                  time.Time
}

func New(base, instanceID, secret string) *Client {
	return &Client{base: strings.TrimRight(base, "/"), instanceID: instanceID, secret: secret, http: &http.Client{Timeout: 10 * time.Second}}
}

// tokenTTL: der Orchestrator stellt 24 h aus, wir erneuern nach 12 h.
const tokenTTL = 12 * time.Hour

func (c *Client) auth() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Since(c.fetched) < tokenTTL {
		return "Bearer " + c.token, nil
	}
	if c.instanceID == "" || c.secret == "" {
		return "", fmt.Errorf("kein OMP_INSTANCE_ID/OMP_LAUNCH_SECRET (Node außerhalb des Launchers gestartet?)")
	}
	body, _ := json.Marshal(map[string]string{"launchSecret": c.secret})
	resp, err := c.http.Post(fmt.Sprintf("%s/api/v1/instances/%s/service-token", c.base, c.instanceID), "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("service-token: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		return "", fmt.Errorf("service-token: ungültige Antwort")
	}
	c.token, c.fetched = out.Token, time.Now()
	return "Bearer " + c.token, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	a, err := c.auth()
	if err != nil {
		return nil, err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", a)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
	}
	return data, nil
}

// Node ist der für VfA nötige Ausschnitt von GET /api/v1/nodes.
type Node struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Online  bool   `json:"online"`
	Senders []struct {
		ID string `json:"id"`
	} `json:"senders"`
}

func (c *Client) Nodes(ctx context.Context) ([]Node, error) {
	b, err := c.do(ctx, http.MethodGet, "/api/v1/nodes", nil)
	if err != nil {
		return nil, err
	}
	var out []Node
	return out, json.Unmarshal(b, &out)
}

func (c *Client) Param(ctx context.Context, node, name string) (json.RawMessage, error) {
	b, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/v1/nodes/%s/params/%s", node, name), nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Value json.RawMessage `json:"value"`
	}
	return out.Value, json.Unmarshal(b, &out)
}

func (c *Client) Invoke(ctx context.Context, node, method string, args map[string]any) error {
	if args == nil {
		args = map[string]any{}
	}
	_, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/api/v1/nodes/%s/methods/%s", node, method), args)
	return err
}

// State liest GET /state eines Nodes (Tonmischer: Kanäle, Gruppen, …).
func (c *Client) State(ctx context.Context, node string) (json.RawMessage, error) {
	b, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/v1/nodes/%s/state", node), nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		State json.RawMessage `json:"state"`
	}
	return out.State, json.Unmarshal(b, &out)
}

// Stream liest einen SSE-Strom (`stream/<name>`) und ruft fn je `data:`-Zeile.
// Endet bei Verbindungsabbruch oder ctx; der Aufrufer baut neu auf.
func (c *Client) Stream(ctx context.Context, node, name string, fn func([]byte)) error {
	a, err := c.auth()
	if err != nil {
		return err
	}
	u := fmt.Sprintf("%s/api/v1/nodes/%s/stream/%s", c.base, node, url.PathEscape(name))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Authorization", a)
	cl := &http.Client{} // ohne Gesamt-Timeout: der Strom läuft dauerhaft
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stream %s: HTTP %d", name, resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if line, ok := strings.CutPrefix(sc.Text(), "data:"); ok {
			fn([]byte(strings.TrimSpace(line)))
		}
	}
	return sc.Err()
}

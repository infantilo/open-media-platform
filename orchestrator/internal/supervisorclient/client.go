// Package supervisorclient ruft den eigenständigen Supervisor-Prozess
// (supervisor/main.go) auf, um einen Datenbank-Restore auszulösen
// (Nutzerwunsch 2026-08-13: Backup/Restore über das Browser-UI) — der
// Orchestrator kann sich nicht selbst befehlen, sich mitten in der
// Restore-Antwort zu stoppen, s. dortiger Paketkommentar. Reiner
// HTTP-Client auf localhost, kein zusätzliches Auth-Schema (gleiche
// Vertrauensgrenze wie beim Supervisor selbst: Loopback-Bindung ist die
// Grenze, s. dessen Kopfkommentar).
package supervisorclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// requestTimeout ist bewusst kurz — der Supervisor antwortet auf
// /restore, SOBALD er den Auftrag angenommen hat (eigene Goroutine für
// die eigentliche Arbeit, s. supervisor/main.go handleRestore-Doku),
// nicht erst nach dem vollständigen Stop→Restore→Start-Zyklus. Ein
// langes Timeout hier würde nur eine echte Fehlfunktion (Supervisor
// hängt) unnötig lange verschleiern.
const requestTimeout = 5 * time.Second

// Client ruft den Supervisor über HTTP an.
type Client struct {
	baseURL string
	http    *http.Client
}

// New — baseURL z. B. "http://127.0.0.1:8091" (config.Config.SupervisorURL).
func New(baseURL string) *Client {
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: requestTimeout}}
}

// TriggerRestore ruft POST {baseURL}/restore mit {"file": file} auf.
func (c *Client) TriggerRestore(ctx context.Context, file string) error {
	body, err := json.Marshal(map[string]string{"file": file})
	if err != nil {
		return fmt.Errorf("request kodieren: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/restore", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("request bauen: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("supervisor nicht erreichbar (läuft er? deploy/dev/start-supervisor.sh): %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusAccepted {
		respBody, _ := io.ReadAll(res.Body)
		return fmt.Errorf("supervisor antwortete mit %d: %s", res.StatusCode, string(respBody))
	}
	return nil
}

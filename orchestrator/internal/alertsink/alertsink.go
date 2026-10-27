// Package alertsink leitet Alarme an ein externes System weiter (Audit 2026-10-23 M7: „kein externes Alarming“ — wer nicht auf die Oberfläche schaut, erfuhr von
// einem ausgefallenen Host oder einer gerissenen Pipeline nichts). Ziel ist ein Webhook (OMP_ALERT_WEBHOOK_URL, optional OMP_ALERT_WEBHOOK_TOKEN als Bearer):
// jeder Alarm geht als JSON hinaus, das neben den strukturierten Feldern ein `text` trägt, damit Slack-/Teams-/Mattermost-kompatible Eingänge ihn
// unmittelbar anzeigen. Quellen: Node-Alarme (omp.alert.<id>) und Host online/offline. Gleiche Meldungen werden zusammengefasst (Entprellen), ein nicht erreichbares Ziel
// bremst den Orchestrator nie (eigene Warteschlange, begrenzt, mit Wiederholung).
package alertsink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// Alert ist ein Alarm.
type Alert struct {
	Kind    string    `json:"kind"`    // node-alert | host-offline | host-online
	Subject string    `json:"subject"` // Node- oder Host-ID
	Name    string    `json:"name,omitempty"`
	Message string    `json:"message"`
	Time    time.Time `json:"time"`
	Text    string    `json:"text"` // Kurztext für Chat-Webhooks
}

// Sink liefert Alarme an das Webhook-Ziel.
type Sink struct {
	URL, Token string
	Client     *http.Client
	// Debounce: gleiche (Art, Gegenstand, Meldung) höchstens einmal in dieser Zeit.
	Debounce time.Duration
	// Retry: Wartezeiten zwischen den Versuchen (Länge = Zahl der Wiederholungen).
	Retry []time.Duration

	queue chan Alert
	mu    sync.Mutex
	last  map[string]time.Time
	now   func() time.Time
}

// New legt einen Sink an; url leer = nil (kein Weiterleiten).
func New(url, token string) *Sink {
	if strings.TrimSpace(url) == "" {
		return nil
	}
	return &Sink{URL: url, Token: token, Client: &http.Client{Timeout: 10 * time.Second}, Debounce: time.Minute,
		Retry: []time.Duration{2 * time.Second, 10 * time.Second, 30 * time.Second}, queue: make(chan Alert, 256), last: map[string]time.Time{}, now: time.Now}
}

// Send stellt einen Alarm in die Warteschlange (nie blockierend; bei voller Warteschlange verfällt er mit einer Log-Warnung).
func (s *Sink) Send(a Alert) {
	if s == nil {
		return
	}
	a.Time = s.now()
	if a.Text == "" {
		a.Text = fmt.Sprintf("[OpenMediaPlatform] %s %s: %s", a.Kind, firstNonEmpty(a.Name, a.Subject), a.Message)
	}
	key := a.Kind + "\x00" + a.Subject + "\x00" + a.Message
	s.mu.Lock()
	if t, ok := s.last[key]; ok && a.Time.Sub(t) < s.Debounce {
		s.mu.Unlock()
		return
	}
	s.last[key] = a.Time
	if len(s.last) > 4096 {
		for k, t := range s.last {
			if a.Time.Sub(t) > s.Debounce {
				delete(s.last, k)
			}
		}
	}
	s.mu.Unlock()
	select {
	case s.queue <- a:
	default:
		slog.Warn("alertsink: Warteschlange voll, Alarm verworfen", "kind", a.Kind, "subject", a.Subject)
	}
}

func firstNonEmpty(v ...string) string {
	for _, x := range v {
		if x != "" {
			return x
		}
	}
	return ""
}

// Run arbeitet die Warteschlange ab, bis ctx endet.
func (s *Sink) Run(ctx context.Context) {
	if s == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case a := <-s.queue:
			s.deliver(ctx, a)
		}
	}
}

func (s *Sink) deliver(ctx context.Context, a Alert) {
	body, _ := json.Marshal(a)
	var err error
	for attempt := 0; ; attempt++ {
		if err = s.post(ctx, body); err == nil {
			return
		}
		if attempt >= len(s.Retry) {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(s.Retry[attempt]):
		}
	}
	slog.Warn("alertsink: Alarm nicht zugestellt", "kind", a.Kind, "subject", a.Subject, "error", err)
}

func (s *Sink) post(ctx context.Context, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Ziel antwortete %d", resp.StatusCode)
	}
	return nil
}

// NodeAlerts leitet die Node-Alarme (SSE-Ereignisse "omp.alert.<id>") weiter, bis ctx endet.
func NodeAlerts(ctx context.Context, hub *sse.Hub, s *Sink) {
	if s == nil {
		return
	}
	ch, cancel := hub.Subscribe()
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if a, ok := FromEvent(ev); ok {
				s.Send(a)
			}
		}
	}
}

// FromEvent macht aus einem Bus-Ereignis einen Alarm (nur "omp.alert.<id>").
func FromEvent(ev sse.Event) (Alert, bool) {
	const prefix = "omp.alert."
	if !strings.HasPrefix(ev.Type, prefix) {
		return Alert{}, false
	}
	id := strings.TrimPrefix(ev.Type, prefix)
	var p struct {
		NodeID  string `json:"node_id"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(ev.Data, &p)
	if p.Message == "" {
		p.Message = string(ev.Data)
	}
	return Alert{Kind: "node-alert", Subject: id, Message: p.Message}, true
}

// HostState ist der beobachtete Zustand eines Hosts.
type HostState struct {
	Name   string
	Online bool
}

// WatchHosts meldet Übergänge online → offline und zurück. Der erste Durchlauf legt nur den Ausgangszustand fest (kein Alarm für Hosts, die beim Start schon fehlen).
// Ein Host, der nur kurz aussetzt, erzeugt dank Entprellen keine Flut.
func WatchHosts(ctx context.Context, every time.Duration, snapshot func() map[string]HostState, s *Sink) {
	if s == nil {
		return
	}
	prev := map[string]HostState{}
	first := true
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		cur := snapshot()
		if !first {
			for id, c := range cur {
				p, known := prev[id]
				switch {
				case known && p.Online && !c.Online:
					s.Send(Alert{Kind: "host-offline", Subject: id, Name: c.Name, Message: "Host nicht mehr erreichbar (keine Telemetrie)"})
				case known && !p.Online && c.Online:
					s.Send(Alert{Kind: "host-online", Subject: id, Name: c.Name, Message: "Host wieder erreichbar"})
				}
			}
		}
		prev, first = cur, false
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

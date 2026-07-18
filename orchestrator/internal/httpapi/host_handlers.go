package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// defaultHistoryWindow/maxHistoryWindow (Kapitel 14 Teil 1,
// docs/END-GOAL-FEATURES.md §14.3a/§14.4): 1h Default (Sparkline in
// Roh-Auflösung), 24h Obergrenze (deckungsgleich mit
// hosts.History-Aggregatfenster — größere Anfragen liefern einfach die
// vollen 24h statt eines Fehlers, gleiche Nachsichtigkeit wie bei
// handleListAuditLog).
const (
	defaultHistoryWindow = time.Hour
	maxHistoryWindow     = 24 * time.Hour
)

// bootstrapTokenTTL ist die Gültigkeitsdauer eines ausgestellten
// Host-Bootstrap-Tokens (ARCHITECTURE.md §18.3 Punkt 1: "z. B. 1 h
// gültig, single-use").
const bootstrapTokenTTL = time.Hour

// HostRegistry verwaltet Bootstrap-Tokens und registrierte Hosts
// (implementiert von *hosts.Store, UMSETZUNG.md D6 Teil 1).
type HostRegistry interface {
	CreateBootstrapToken(createdBy string, ttl time.Duration) (token string, expiresAt time.Time, err error)
	ConsumeBootstrapToken(token string) error
	CreateHost(label, hostname string, capabilities []byte) (hosts.Host, error)
	ListHosts() ([]hosts.Host, error)
}

// HostMetricsReader liefert die zuletzt per NATS empfangene Telemetrie
// eines Hosts (implementiert von *hosts.Tracker).
type HostMetricsReader interface {
	Get(hostID string) (hosts.Metrics, bool)
}

// HostHistoryReader liefert die Zeitreihe eines Hosts über ein Fenster
// (implementiert von *hosts.History, Kapitel 14 Teil 1).
type HostHistoryReader interface {
	Window(hostID string, window time.Duration) (hosts.HistoryWindow, bool)
}

type bootstrapTokenResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// handleCreateBootstrapToken ist POST /api/v1/admin/hosts/bootstrap-tokens
// — admin-only (server.go), ARCHITECTURE.md §18.3 Punkt 1. `createdBy`
// kommt aus dem authentifizierten Principal, nicht aus dem Request-Body
// (Audit-Nachvollziehbarkeit: wer hat wann welchen Host zum Beitritt
// eingeladen).
func handleCreateBootstrapToken(registry HostRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, _ := principalFromContext(r)
		createdBy := p.Username
		if createdBy == "" {
			createdBy = "bootstrap" // Bootstrap-Modus vor D3 Teil 2: kein Nutzer, s. authGate.
		}
		token, expiresAt, err := registry.CreateBootstrapToken(createdBy, bootstrapTokenTTL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, bootstrapTokenResponse{Token: token, ExpiresAt: expiresAt})
	}
}

type registerHostRequest struct {
	Token        string          `json:"token"`
	Label        string          `json:"label"`
	Hostname     string          `json:"hostname"`
	Capabilities json.RawMessage `json:"capabilities"`
}

type registerHostResponse struct {
	HostID string `json:"hostId"`
	Label  string `json:"label"`
}

// handleRegisterHost ist POST /api/v1/hosts/register — bewusst
// **außerhalb** von authGate (server.go): der registrierende
// omp-host-agent ist kein angemeldeter Nutzer, seine Zugriffskontrolle
// ist das Bootstrap-Token selbst (ARCHITECTURE.md §18.3 Punkt 3/4 —
// "Erkennung ist nie ungesichert-anonym"), nicht ein Bearer-Token aus
// internal/auth. Broadcastet nach erfolgreicher Registrierung
// "host.registered" (S2 — docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md):
// hosts-view.ts soll einen neuen Host ohne Poll <1s anzeigen, statt bis
// zum nächsten Poll-Intervall zu warten. events darf nil sein (z. B. in
// Tests) — dann bleibt das Verhalten unverändert (kein Broadcast, kein
// Fehler).
func handleRegisterHost(registry HostRegistry, events EventSubscriber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req registerHostRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" || req.Label == "" || req.Hostname == "" {
			http.Error(w, "token, label and hostname required", http.StatusBadRequest)
			return
		}
		if err := registry.ConsumeBootstrapToken(req.Token); err != nil {
			if errors.Is(err, hosts.ErrInvalidToken) {
				http.Error(w, "invalid or already-used bootstrap token", http.StatusUnauthorized)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		h, err := registry.CreateHost(req.Label, req.Hostname, req.Capabilities)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if events != nil {
			// Reiner Trigger (gleiches Muster wie audit.Store.Log):
			// hosts-view.ts lädt bei Empfang einmal GET /api/v1/hosts neu.
			data, err := json.Marshal(registerHostResponse{HostID: h.ID, Label: h.Label})
			if err == nil {
				events.Broadcast(sse.Event{Type: "host.registered", Data: data})
			}
		}
		writeJSON(w, http.StatusCreated, registerHostResponse{HostID: h.ID, Label: h.Label})
	}
}

type hostResponse struct {
	ID           string          `json:"id"`
	Label        string          `json:"label"`
	Hostname     string          `json:"hostname"`
	Capabilities json.RawMessage `json:"capabilities"`
	RegisteredAt time.Time       `json:"registeredAt"`
	Metrics      *hosts.Metrics  `json:"metrics,omitempty"`
}

// handleListHosts ist GET /api/v1/hosts (ARCHITECTURE.md §18.7:
// "Sichtbarkeit im UI") — authentifiziert, kein weiterer Verb-Scope
// (view-artig, wie die übrigen Bestandslisten-Endpunkte).
func handleListHosts(registry HostRegistry, metrics HostMetricsReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		all, err := registry.ListHosts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]hostResponse, len(all))
		for i, h := range all {
			out[i] = hostResponse{
				ID:           h.ID,
				Label:        h.Label,
				Hostname:     h.Hostname,
				Capabilities: json.RawMessage(h.Capabilities),
				RegisteredAt: h.RegisteredAt,
			}
			if m, ok := metrics.Get(h.ID); ok {
				out[i].Metrics = &m
			}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleHostMetricsHistory ist GET /api/v1/hosts/{id}/metrics/history?
// window=<Go-Duration, z. B. "1h"/"24h"> (Kapitel 14 Teil 1,
// docs/END-GOAL-FEATURES.md §14.4 Teil 1) — Sparkline- und
// Min/Ø/Max-Datengrundlage für hosts-view.ts. Kein 404 bei unbekannter
// Host-ID (view-artiger Endpunkt wie handleListHosts: der Aufrufer weiß
// bereits, welche IDs existieren, per GET /api/v1/hosts) — stattdessen
// ein leeres Fenster, damit ein Host ohne jemals empfangene Telemetrie
// (z. B. gerade erst registriert) keinen Fehler auslöst.
func handleHostMetricsHistory(history HostHistoryReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hostID := r.PathValue("id")
		window := defaultHistoryWindow
		if v := r.URL.Query().Get("window"); v != "" {
			if parsed, err := time.ParseDuration(v); err == nil && parsed > 0 {
				window = parsed
			}
		}
		if window > maxHistoryWindow {
			window = maxHistoryWindow
		}

		win, ok := history.Window(hostID, window)
		if !ok {
			win = hosts.HistoryWindow{Resolution: "raw"}
		}
		writeJSON(w, http.StatusOK, win)
	}
}

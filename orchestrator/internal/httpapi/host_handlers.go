package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/ioports"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// IOPortInventoryStore verwaltet das I/O-Karten-Inventar/-Belegung
// (implementiert von *ioports.Store, ARCHITECTURE.md §6.1 Erweiterung
// 2026-07-10, UMSETZUNG.md D13). Anders als die übrigen httpapi-
// Abhängigkeiten (WorkflowService, ClusterService, …) bewusst mit dem
// konkreten ioports.Port/ioports.Claim-Typ statt eigener Platzhalter —
// httpapi ist bereits die äußere Komposition-Schicht (importiert auch
// hosts.Host direkt), keine weitere Entkopplung nötig.
type IOPortInventoryStore interface {
	SetInventory(hostID string, ports []ioports.Port) error
	ListAllPorts() ([]ioports.Port, error)
	ListClaims() ([]ioports.Claim, error)
	// Claim/UpdateInstanceID/ReleasePort/ReleaseClaimedByInstance
	// (Nutzerfund 2026-08-20, "deklink node crasht immer noch beim
	// start"): handlePostInstance/handleDeleteInstance (launcher_
	// handlers.go) brauchen denselben Claim-Mechanismus wie
	// workflows.Service.Start()/Stop() — ein direkt über den Node-
	// Katalog/die Instanzen-API gestarteter `omp-decklink` (kein
	// Workflow-Kontext) durchlief bisher NIE claimIOPortsForStart, bekam
	// also nie einen echten Port zugewiesen. `ReleasePort`/
	// `ReleaseClaimedByInstance` statt `Release(workflowID, role)`: der
	// direkte Start-Pfad kennt Host/Port bzw. die Instanz-ID direkt,
	// keinen stabilen (workflowID, role)-Schlüssel wie ein Workflow.
	Claim(cardType, direction, preferredHostID, workflowID, role, instanceID string) (hostID, portID string, ok bool, err error)
	UpdateInstanceID(workflowID, role, instanceID string) error
	ReleasePort(hostID, portID string) error
	ReleaseClaimedByInstance(instanceID string) error
}

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

// ioPortEntry ist ein einzelner Port im Registrierungs-Request — ohne
// HostID (die kennt der Host-Agent noch nicht, sie entsteht erst mit
// registry.CreateHost unten), sonst identisch zu ioports.Port.
type ioPortEntry struct {
	PortID    string `json:"portId"`
	CardType  string `json:"cardType"`
	Direction string `json:"direction"`
	Label     string `json:"label,omitempty"`
}

type registerHostRequest struct {
	Token        string          `json:"token"`
	Label        string          `json:"label"`
	Hostname     string          `json:"hostname"`
	Capabilities json.RawMessage `json:"capabilities"`
	// IOPorts (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10, UMSETZUNG.md
	// D13): das vom Host-Agent lokal konfigurierte I/O-Karten-Inventar
	// (host-agent/main.go: OMP_HOST_AGENT_IO_PORTS) — leer/weggelassen
	// ist der Normalfall (kein Inventar, unverändertes Verhalten vor
	// D13).
	IOPorts []ioPortEntry `json:"ioPorts,omitempty"`
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
func handleRegisterHost(registry HostRegistry, ioPortStore IOPortInventoryStore, events EventSubscriber) http.HandlerFunc {
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
		// D13: I/O-Port-Inventar erst NACH CreateHost (host_io_ports hat
		// einen Fremdschlüssel auf hosts.id) — best effort wie die
		// SSE-Benachrichtigung unten: ein Fehler hier lässt die
		// Host-Registrierung selbst nicht scheitern (der Host ist
		// bereits angelegt und ohne I/O-Karten-Funktion nutzbar), nur
		// sein Inventar bliebe leer.
		if ioPortStore != nil {
			ports := make([]ioports.Port, len(req.IOPorts))
			for i, p := range req.IOPorts {
				ports[i] = ioports.Port{HostID: h.ID, PortID: p.PortID, CardType: p.CardType, Direction: p.Direction, Label: p.Label}
			}
			if err := ioPortStore.SetInventory(h.ID, ports); err != nil {
				slog.Warn("hosts: set io port inventory failed", "host_id", h.ID, "error", err)
			}
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
	// IOPorts/IOPortClaims (ARCHITECTURE.md §18.7, UMSETZUNG.md D13) —
	// leer, wenn kein I/O-Port-Store verdrahtet ist oder der Host kein
	// Inventar gemeldet hat (unverändertes Verhalten vor D13).
	IOPorts      []ioports.Port  `json:"ioPorts,omitempty"`
	IOPortClaims []ioports.Claim `json:"ioPortClaims,omitempty"`
}

// handleListHosts ist GET /api/v1/hosts (ARCHITECTURE.md §18.7:
// "Sichtbarkeit im UI") — authentifiziert, kein weiterer Verb-Scope
// (view-artig, wie die übrigen Bestandslisten-Endpunkte). ioPortStore
// darf nil sein (z. B. Tests) — dann bleiben IOPorts/IOPortClaims leer,
// sonst unverändertes Verhalten.
func handleListHosts(registry HostRegistry, metrics HostMetricsReader, ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		all, err := registry.ListHosts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var allPorts []ioports.Port
		var allClaims []ioports.Claim
		if ioPortStore != nil {
			allPorts, err = ioPortStore.ListAllPorts()
			if err != nil {
				slog.Warn("hosts: list io ports failed", "error", err)
			}
			allClaims, err = ioPortStore.ListClaims()
			if err != nil {
				slog.Warn("hosts: list io port claims failed", "error", err)
			}
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
			for _, p := range allPorts {
				if p.HostID == h.ID {
					out[i].IOPorts = append(out[i].IOPorts, p)
				}
			}
			for _, c := range allClaims {
				if c.HostID == h.ID {
					out[i].IOPortClaims = append(out[i].IOPortClaims, c)
				}
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

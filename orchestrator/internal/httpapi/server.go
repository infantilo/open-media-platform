// Package httpapi stellt den HTTP-Handler des Orchestrators bereit:
// generische REST-Endpunkte plus statisches Ausliefern der UI-Shell.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// AppName identifiziert den Orchestrator in /api/v1/info und Logs.
const AppName = "openmediaplatform-orchestrator"

// Version wird in späteren Schritten per ldflags beim Build gesetzt.
var Version = "dev"

// InfoResponse ist der Body von GET /api/v1/info.
type InfoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// NodeLister liefert den zuletzt bekannten Node-Snapshot (implementiert von
// *registry.Store); als Interface gehalten, damit Handler-Tests ohne
// echten Poller auskommen. Get wird vom generischen Parameter-/Methoden-
// Proxy (A8) genutzt, um die API-Basis-URL eines Nodes aufzulösen.
type NodeLister interface {
	List() []registry.NodeView
	Get(id string) (registry.NodeView, bool)
}

// EventSubscriber liefert einen Event-Kanal für einen neuen SSE-Client
// (implementiert von *sse.Hub).
type EventSubscriber interface {
	Subscribe() (<-chan sse.Event, func())
}

// GraphService baut den Flow-Editor-Graphen und führt IS-05-
// Verbindungsänderungen aus (implementiert von *graph.Service).
type GraphService interface {
	Graph(ctx context.Context) graph.Graph
	Connect(ctx context.Context, fromSender, toReceiver string) error
	Disconnect(ctx context.Context, receiverID string) error
}

// LayoutStore persistiert benannte Layout-Blobs (implementiert von
// *layouts.Store) — der Orchestrator kennt deren Struktur nicht, reines
// Opak-Speichern (UMSETZUNG.md B5).
type LayoutStore interface {
	Get(name string) (json.RawMessage, error)
	Put(name string, data json.RawMessage) error
}

// SnapshotService erfasst und stellt Szenen wieder her (implementiert
// von *snapshots.Service, UMSETZUNG.md B7).
type SnapshotService interface {
	Create(ctx context.Context, label string) (snapshots.Snapshot, error)
	List() ([]snapshots.Snapshot, error)
	Apply(ctx context.Context, id string) (snapshots.ApplyResult, error)
}

// NewHandler baut den kompletten HTTP-Handler des Orchestrators:
// /healthz, /api/v1/info, /api/v1/nodes, /api/v1/events, /api/v1/graph,
// /api/v1/layouts, /api/v1/snapshots und statisches Serving von
// cfg.UIDir unter /.
func NewHandler(cfg config.Config, nodes NodeLister, events EventSubscriber, graphSvc GraphService, layoutStore LayoutStore, snapshotSvc SnapshotService) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /api/v1/info", handleInfo)
	mux.HandleFunc("GET /api/v1/nodes", handleNodes(nodes))
	mux.HandleFunc("GET /api/v1/events", handleEvents(events))
	mux.HandleFunc("GET /api/v1/nodes/{id}/descriptor", handleNodeProxy(nodes, "/descriptor.json"))
	mux.HandleFunc("GET /api/v1/nodes/{id}/params/{name}", handleNodeProxy(nodes, "/params/{name}"))
	mux.HandleFunc("PATCH /api/v1/nodes/{id}/params/{name}", handleNodeProxy(nodes, "/params/{name}"))
	mux.HandleFunc("POST /api/v1/nodes/{id}/methods/{name}", handleNodeProxy(nodes, "/methods/{name}"))
	mux.HandleFunc("GET /api/v1/nodes/{id}/ui/manifest.json", handleNodeProxy(nodes, "/ui/manifest.json"))
	mux.HandleFunc("GET /api/v1/nodes/{id}/ui/bundle.js", handleNodeProxy(nodes, "/ui/bundle.js"))
	mux.HandleFunc("GET /api/v1/graph", handleGraph(graphSvc))
	mux.HandleFunc("POST /api/v1/graph/edges", handlePostGraphEdge(graphSvc))
	mux.HandleFunc("DELETE /api/v1/graph/edges/{id}", handleDeleteGraphEdge(graphSvc))
	mux.HandleFunc("GET /api/v1/layouts/{name}", handleGetLayout(layoutStore))
	mux.HandleFunc("PUT /api/v1/layouts/{name}", handlePutLayout(layoutStore))
	mux.HandleFunc("GET /api/v1/snapshots", handleListSnapshots(snapshotSvc))
	mux.HandleFunc("POST /api/v1/snapshots", handleCreateSnapshot(snapshotSvc))
	mux.HandleFunc("POST /api/v1/snapshots/{id}/apply", handleApplySnapshot(snapshotSvc))
	mux.Handle("/", http.FileServer(http.Dir(cfg.UIDir)))
	return noStoreForAPI(mux)
}

// noStoreForAPI markiert alle /api/v1/*-Antworten als nicht cachebar.
// Ohne das kann der Browser GET-Antworten (Graph, Nodes, Snapshot-Liste,
// Node-Proxy-Parameter …) je nach Heuristik zwischenspeichern und nach
// einer Änderung veraltete Daten zeigen, bis ein vollständiger Reload
// einen echten Request erzwingt — im Browser bei B7 beobachtet
// (Snapshot-Leiste aktualisierte sich nicht sofort, Parameter-Panel
// zeigte nach einem Apply erst nach erneuter Node-Auswahl den neuen
// Wert). Statisches UI-Serving (/, /dist/…) ist von der Regel
// ausgenommen, da Caching dort unproblematisch/gewünscht ist.
func noStoreForAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, InfoResponse{Name: AppName, Version: Version})
}

func handleNodes(nodes NodeLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, nodes.List())
	}
}

// handleEvents liefert Bus-Ereignisse und Node-Inventar-Änderungen als
// Server-Sent-Events-Stream (UMSETZUNG.md A6).
func handleEvents(events EventSubscriber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch, cancel := events.Subscribe()
		defer cancel()

		for {
			select {
			case <-r.Context().Done():
				return
			case ev, ok := <-ch:
				if !ok {
					return
				}
				data, err := json.Marshal(ev)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "data: %s\n\n", data)
				flusher.Flush()
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

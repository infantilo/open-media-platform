// Package httpapi stellt den HTTP-Handler des Orchestrators bereit:
// generische REST-Endpunkte plus statisches Ausliefern der UI-Shell.
package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
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
// echten Poller auskommen.
type NodeLister interface {
	List() []registry.NodeView
}

// EventSubscriber liefert einen Event-Kanal für einen neuen SSE-Client
// (implementiert von *sse.Hub).
type EventSubscriber interface {
	Subscribe() (<-chan sse.Event, func())
}

// NewHandler baut den kompletten HTTP-Handler des Orchestrators:
// /healthz, /api/v1/info, /api/v1/nodes, /api/v1/events und statisches
// Serving von cfg.UIDir unter /.
func NewHandler(cfg config.Config, nodes NodeLister, events EventSubscriber) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /api/v1/info", handleInfo)
	mux.HandleFunc("GET /api/v1/nodes", handleNodes(nodes))
	mux.HandleFunc("GET /api/v1/events", handleEvents(events))
	mux.Handle("/", http.FileServer(http.Dir(cfg.UIDir)))
	return mux
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

// Package sse implementiert einen minimalen Server-Sent-Events-Hub:
// Publisher senden Event-Werte, beliebig viele Browser-Clients erhalten
// jeweils eine eigene Kopie über /api/v1/events.
package sse

import (
	"encoding/json"
	"sync"
)

// Event ist die über den SSE-Stream ausgelieferte Hülle. Type identifiziert
// den Ereignistyp (NATS-Subject wie "omp.health.<id>" oder synthetische
// Node-Inventar-Änderungen wie "node.added").
type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Hub verteilt Events an alle aktuell verbundenen SSE-Clients.
type Hub struct {
	mu      sync.Mutex
	clients map[chan Event]struct{}
}

// NewHub erstellt einen leeren Hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[chan Event]struct{})}
}

// Subscribe registriert einen neuen Client und liefert dessen Event-Kanal
// sowie eine cancel-Funktion, die beim Verbindungsende aufgerufen werden
// muss (schließt den Kanal, entfernt den Client aus dem Hub).
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 16)

	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()

	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.clients[ch]; ok {
			delete(h.clients, ch)
			close(ch)
		}
	}
	return ch, cancel
}

// Broadcast sendet ein Event an alle verbundenen Clients. Ein langsamer
// Client (voller Puffer) verliert das Event statt den Hub zu blockieren.
func (h *Hub) Broadcast(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- e:
		default:
		}
	}
}

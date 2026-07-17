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

// lostEventsEvent wird einem Client zugestellt, sobald wieder Platz in
// seinem Puffer ist, nachdem ihm zuvor mindestens ein Event verloren
// gegangen war (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md S2). Der
// Payload trägt keine Nutzdaten — reiner Trigger, wie bei den übrigen
// synthetischen Events (s. graph.Service.publish), die UI lädt bei
// Empfang einmal den vollen Zustand statt der einzelnen Events neu.
var lostEventsEvent = Event{Type: "lost-events", Data: json.RawMessage("null")}

// Hub verteilt Events an alle aktuell verbundenen SSE-Clients.
type Hub struct {
	mu      sync.Mutex
	clients map[chan Event]struct{}
	// dropped merkt sich Clients, denen seit ihrem letzten erfolgreichen
	// Empfang mindestens ein Event verloren ging (voller Puffer) — S2:
	// diese Clients bekommen bei der nächsten Gelegenheit lostEventsEvent
	// zugestellt, statt still auf veraltetem Stand zu bleiben.
	dropped map[chan Event]bool
}

// NewHub erstellt einen leeren Hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[chan Event]struct{}), dropped: make(map[chan Event]bool)}
}

// Subscribe registriert einen neuen Client und liefert dessen Event-Kanal
// sowie eine cancel-Funktion, die beim Verbindungsende aufgerufen werden
// muss (schließt den Kanal, entfernt den Client aus dem Hub).
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 16)

	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() { h.unsubscribe(ch) }
}

// unsubscribe entfernt einen Client (eigene Methode statt in der
// cancel-Closure inline, damit Hub-Tests im selben Package einen
// Client ohne den narrowenden <-chan-Rückgabetyp von Subscribe direkt
// registrieren/abmelden können, s. hub_test.go).
func (h *Hub) unsubscribe(ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		delete(h.dropped, ch)
		close(ch)
	}
}

// Broadcast sendet ein Event an alle verbundenen Clients. Ein langsamer
// Client (voller Puffer) verliert das Event statt den Hub zu blockieren
// — merkt sich das aber (dropped), um dem Client bei der nächsten
// Gelegenheit lostEventsEvent zuzustellen (S2, s. Feld-Kommentar oben).
func (h *Hub) Broadcast(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		if h.dropped[ch] {
			select {
			case ch <- lostEventsEvent:
				delete(h.dropped, ch)
			default:
				continue // Puffer immer noch voll — e ist für diesen Client ebenfalls verloren, dropped bleibt gesetzt
			}
		}
		select {
		case ch <- e:
		default:
			h.dropped[ch] = true
		}
	}
}

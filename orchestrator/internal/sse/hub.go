// Package sse implementiert einen minimalen Server-Sent-Events-Hub:
// Publisher senden Event-Werte, beliebig viele Browser-Clients erhalten
// jeweils eine eigene Kopie über /api/v1/events.
package sse

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

// ClientInfo beschreibt einen verbundenen SSE-Client für die Admin-Ansicht.
type ClientInfo struct {
	ID        string    `json:"id"`
	User      string    `json:"user"`
	RemoteIP  string    `json:"remoteIp"`
	UserAgent string    `json:"userAgent"`
	Since     time.Time `json:"since"`
}

// Event ist die über den SSE-Stream ausgelieferte Hülle. Type identifiziert
// den Ereignistyp (NATS-Subject wie "omp.health.<id>" oder synthetische
// Node-Inventar-Änderungen wie "node.added").
type Event struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`

	// wire hält die einmalig (in Broadcast) serialisierte JSON-Form, damit
	// nicht jeder verbundene Client dasselbe Event erneut marshalt.
	wire []byte
}

// Wire liefert die JSON-Form des Events (vorberechnet, falls vom Hub verteilt).
func (e Event) Wire() ([]byte, error) {
	if e.wire != nil {
		return e.wire, nil
	}
	return json.Marshal(e)
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
	// totalDrops zählt jeden fehlgeschlagenen Zustellversuch kumulativ
	// (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "SSE-Clients+Drops"
	// für /metrics) — anders als `dropped` (aktueller Zustand pro Client)
	// wird dieser Zähler nie zurückgesetzt, ein monoton wachsender
	// Prometheus-Counter.
	totalDrops uint64
	// info hält je Client die Verbindungsdaten (nur für Clients, die über SubscribeInfo kamen).
	info map[chan Event]ClientInfo
	// totalKicks zählt vom Admin getrennte Clients seit Prozessstart.
	totalKicks uint64
}

// NewHub erstellt einen leeren Hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[chan Event]struct{}), dropped: make(map[chan Event]bool), info: make(map[chan Event]ClientInfo)}
}

// Subscribe registriert einen neuen Client und liefert dessen Event-Kanal
// sowie eine cancel-Funktion, die beim Verbindungsende aufgerufen werden
// muss (schließt den Kanal, entfernt den Client aus dem Hub).
func (h *Hub) Subscribe() (<-chan Event, func()) {
	return h.SubscribeInfo(ClientInfo{})
}

// SubscribeInfo wie Subscribe, merkt sich zusätzlich Benutzer/IP/Start des Clients
// (Since wird gesetzt, falls leer). Ein Client ohne User und IP wird nicht aufgelistet.
func (h *Hub) SubscribeInfo(ci ClientInfo) (<-chan Event, func()) {
	ch := make(chan Event, 16)
	if ci.Since.IsZero() {
		ci.Since = time.Now()
	}

	h.mu.Lock()
	h.clients[ch] = struct{}{}
	if ci.User != "" || ci.RemoteIP != "" {
		var b [6]byte
		_, _ = rand.Read(b[:])
		ci.ID = hex.EncodeToString(b[:])
		h.info[ch] = ci
	}
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
		delete(h.info, ch)
		close(ch)
	}
}

// Broadcast sendet ein Event an alle verbundenen Clients. Ein langsamer
// Client (voller Puffer) verliert das Event statt den Hub zu blockieren
// — merkt sich das aber (dropped), um dem Client bei der nächsten
// Gelegenheit lostEventsEvent zuzustellen (S2, s. Feld-Kommentar oben).
func (h *Hub) Broadcast(e Event) {
	if w, err := json.Marshal(e); err == nil {
		e.wire = w
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		if h.dropped[ch] {
			select {
			case ch <- lostEventsEvent:
				delete(h.dropped, ch)
			default:
				h.totalDrops++
				continue // Puffer immer noch voll — e ist für diesen Client ebenfalls verloren, dropped bleibt gesetzt
			}
		}
		select {
		case ch <- e:
		default:
			h.dropped[ch] = true
			h.totalDrops++
		}
	}
}

// ClientCount liefert die Anzahl aktuell verbundener SSE-Clients (S8).
func (h *Hub) ClientCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Clients liefert die aktuell verbundenen, identifizierten SSE-Clients (älteste zuerst).
func (h *Hub) Clients() []ClientInfo {
	h.mu.Lock()
	out := make([]ClientInfo, 0, len(h.info))
	for _, ci := range h.info {
		out = append(out, ci)
	}
	h.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Since.Before(out[j].Since) })
	return out
}

// Kick trennt den Client mit dieser ID (schließt seinen Kanal; der SSE-Handler beendet daraufhin den
// Stream). Liefert false, wenn es ihn nicht (mehr) gibt. Der Browser baut den Stream von selbst wieder auf,
// solange seine Anmeldung gültig ist.
func (h *Hub) Kick(id string) bool {
	h.mu.Lock()
	var target chan Event
	for ch, ci := range h.info {
		if ci.ID == id {
			target = ch
			break
		}
	}
	if target != nil {
		h.totalKicks++
	}
	h.mu.Unlock()
	if target == nil {
		return false
	}
	h.unsubscribe(target)
	return true
}

// KickUser trennt alle Clients eines Benutzers und liefert deren Anzahl.
func (h *Hub) KickUser(user string) int {
	h.mu.Lock()
	var targets []chan Event
	for ch, ci := range h.info {
		if ci.User == user {
			targets = append(targets, ch)
		}
	}
	h.totalKicks += uint64(len(targets))
	h.mu.Unlock()
	for _, ch := range targets {
		h.unsubscribe(ch)
	}
	return len(targets)
}

// TotalKicks liefert die Anzahl vom Admin getrennter Clients seit Prozessstart.
func (h *Hub) TotalKicks() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.totalKicks
}

// TotalDrops liefert die kumulative Anzahl fehlgeschlagener
// Event-Zustellversuche seit Prozessstart (S8) — s. totalDrops-Doku.
func (h *Hub) TotalDrops() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.totalDrops
}

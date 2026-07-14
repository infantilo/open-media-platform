package hosts

import (
	"encoding/json"
	"sync"
	"time"
)

// Tracker hält die zuletzt über NATS empfangene Telemetrie pro Host-ID,
// nebenläufig sicher nutzbar — gleiches Musters wie
// internal/health.Tracker, nur mit dem tatsächlichen Payload statt nur
// einem Zeitstempel (die UI zeigt CPU/RAM, nicht nur "online/offline").
type Tracker struct {
	mu     sync.RWMutex
	latest map[string]Metrics
}

// NewTracker erstellt einen leeren Tracker.
func NewTracker() *Tracker {
	return &Tracker{latest: make(map[string]Metrics)}
}

// Touch verarbeitet einen auf omp.host.<hostID>.metrics empfangenen
// JSON-Payload. Ein nicht parsbarer Payload wird verworfen (Log beim
// Aufrufer, s. main.go) statt den Orchestrator abstürzen zu lassen —
// gleiche Robustheits-Linie wie eventbus.normalizePayload.
func (t *Tracker) Touch(hostID string, payload []byte) bool {
	var m Metrics
	if err := json.Unmarshal(payload, &m); err != nil {
		return false
	}
	m.ReceivedAt = time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.latest[hostID] = m
	return true
}

// Get liefert die zuletzt gesehene Telemetrie für hostID (ok=false, wenn
// noch nie eine empfangen wurde).
func (t *Tracker) Get(hostID string) (Metrics, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	m, ok := t.latest[hostID]
	return m, ok
}

// Package health verfolgt, wann zuletzt ein NATS-Health-Event
// (omp.health.<id>, siehe UMSETZUNG.md A7) eines Nodes gesehen wurde.
// Grundlage für die schnellere Offline-Erkennung in B4: die
// IS-04-Registry entfernt eine Node erst nach
// registration_expiry_interval (12s, deploy/nmos/registry.json)
// vollständig — der Health-Tracker erlaubt, eine Node schon als
// "offline" zu markieren, während sie im Registry-Snapshot noch
// existiert, sobald sie länger als der konfigurierte Schwellwert
// keinen Herzschlag mehr gesendet hat.
package health

import (
	"sync"
	"time"
)

// Tracker hält den Zeitpunkt des letzten gesehenen Health-Events pro
// Node-ID, nebenläufig sicher nutzbar.
type Tracker struct {
	mu       sync.RWMutex
	lastSeen map[string]time.Time
}

// NewTracker erstellt einen leeren Tracker.
func NewTracker() *Tracker {
	return &Tracker{lastSeen: make(map[string]time.Time)}
}

// Touch vermerkt, dass jetzt ein Health-Event für nodeID eingetroffen ist.
func (t *Tracker) Touch(nodeID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastSeen[nodeID] = time.Now()
}

// IsStale liefert true, wenn seit dem letzten Health-Event mehr als
// threshold vergangen ist. Für eine Node, von der noch nie ein
// Health-Event gesehen wurde, liefert IsStale false — fehlende Daten
// werden nicht vorsorglich als "offline" gewertet (z. B. Nodes, die gar
// keine NATS-Health-Events publizieren, sollen nicht fälschlich als
// offline erscheinen).
func (t *Tracker) IsStale(nodeID string, threshold time.Duration) bool {
	return t.isStaleAt(nodeID, threshold, time.Now())
}

func (t *Tracker) isStaleAt(nodeID string, threshold time.Duration, now time.Time) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	last, ok := t.lastSeen[nodeID]
	if !ok {
		return false
	}
	return now.Sub(last) > threshold
}

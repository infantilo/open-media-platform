package registry

import (
	"sync"
	"time"
)

// Store hält den zuletzt erfolgreich abgefragten Node-Snapshot im Speicher,
// nebenläufig lesbar/schreibbar. Ein fehlgeschlagener Poll überschreibt den
// Store nicht (siehe Poller) — Konsumenten sehen immer den letzten
// bekannten Zustand statt eines leeren Zwischenstands.
type Store struct {
	mu    sync.RWMutex
	nodes []NodeView
	// pollDuration ist die Dauer des zuletzt abgeschlossenen Polls (S8,
	// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md: "Registry- (Nodes
	// online/gesamt, Poll-Dauer)" für /metrics) — hier statt auf *Poller
	// gehalten, weil der Store (nicht der Poller selbst) bereits als
	// NodeLister in httpapi.NewHandler injiziert wird; ein zusätzlicher
	// Konstruktor-Parameter nur für diesen einen Wert wäre unnötig.
	pollDuration time.Duration
}

// NewStore erstellt einen leeren Store.
func NewStore() *Store {
	return &Store{nodes: []NodeView{}}
}

// Set ersetzt den gespeicherten Node-Snapshot.
func (s *Store) Set(nodes []NodeView) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes = nodes
}

// List liefert eine Kopie des zuletzt gespeicherten Node-Snapshots.
func (s *Store) List() []NodeView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]NodeView, len(s.nodes))
	copy(out, s.nodes)
	return out
}

// Get liefert den zuletzt gespeicherten Stand eines einzelnen Nodes.
func (s *Store) Get(id string) (NodeView, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, n := range s.nodes {
		if n.ID == id {
			return n, true
		}
	}
	return NodeView{}, false
}

// GetByInstanceID liefert den Node, dessen "urn:x-omp:instance"-Tag
// (NodeView.InstanceID) instanceID entspricht — anders als Get() (NMOS-
// Node-ID, ändert sich bei jedem Prozessstart ohne stabilen Seed) ist
// die Instanz-ID über einen Neustart hinweg stabil (Launcher-vergeben,
// UMSETZUNG.md C8). Grundlage für Kapitel 21 Phase 4 Teil 2
// (internal/process: MediaFunction-Schritte referenzieren eine Instanz,
// nicht eine flüchtige Node-ID) — dasselbe Auflösungsbedürfnis, das
// internal/workflows bisher nur workflow-intern über Role-Namen löst.
func (s *Store) GetByInstanceID(instanceID string) (NodeView, bool) {
	if instanceID == "" {
		return NodeView{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, n := range s.nodes {
		if n.InstanceID == instanceID {
			return n, true
		}
	}
	return NodeView{}, false
}

// SetPollDuration wird vom Poller nach jedem abgeschlossenen (auch
// fehlgeschlagenen) Poll aufgerufen (S8).
func (s *Store) SetPollDuration(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pollDuration = d
}

// PollDuration liefert die Dauer des zuletzt abgeschlossenen Polls.
func (s *Store) PollDuration() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pollDuration
}

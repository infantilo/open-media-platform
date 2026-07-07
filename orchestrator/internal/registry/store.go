package registry

import "sync"

// Store hält den zuletzt erfolgreich abgefragten Node-Snapshot im Speicher,
// nebenläufig lesbar/schreibbar. Ein fehlgeschlagener Poll überschreibt den
// Store nicht (siehe Poller) — Konsumenten sehen immer den letzten
// bekannten Zustand statt eines leeren Zwischenstands.
type Store struct {
	mu    sync.RWMutex
	nodes []NodeView
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

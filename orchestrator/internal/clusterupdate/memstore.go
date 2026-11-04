package clusterupdate

import (
	"encoding/json"
	"sync"
)

// MemStore hält den Zustand im Speicher (Tests und Ein-Prozess-Läufe).
type MemStore struct {
	mu   sync.Mutex
	list []*Rollout
}

func clone(r *Rollout) *Rollout {
	b, _ := json.Marshal(r)
	var c Rollout
	_ = json.Unmarshal(b, &c)
	return &c
}

func (m *MemStore) Active() (*Rollout, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.list {
		if r.State == StateRunning || r.State == StateFailed {
			return clone(r), nil
		}
	}
	return nil, nil
}

func (m *MemStore) Latest() (*Rollout, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.list) == 0 {
		return nil, nil
	}
	return clone(m.list[len(m.list)-1]), nil
}

func (m *MemStore) Create(r *Rollout) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.list {
		if o.State == StateRunning || o.State == StateFailed {
			return ErrActive
		}
	}
	m.list = append(m.list, clone(r))
	return nil
}

func (m *MemStore) Save(r *Rollout) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, o := range m.list {
		if o.ID == r.ID {
			m.list[i] = clone(r)
			return nil
		}
	}
	m.list = append(m.list, clone(r))
	return nil
}

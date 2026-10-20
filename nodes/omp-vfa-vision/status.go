package main

import (
	"sort"
	"sync"
	"time"
)

// camState ist der Live-Zustand einer Kamera für die Oberfläche.
type camState struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Faces []Face `json:"faces"`
	AgeMs int64  `json:"ageMs"`
	at    time.Time
}

type statusStore struct {
	mu   sync.Mutex
	cams map[string]*camState
}

var status = &statusStore{cams: map[string]*camState{}}

func (s *statusStore) add(id, url string) {
	s.mu.Lock()
	s.cams[id] = &camState{ID: id, URL: url, Faces: []Face{}}
	s.mu.Unlock()
}

func (s *statusStore) remove(id string) {
	s.mu.Lock()
	delete(s.cams, id)
	s.mu.Unlock()
}

func (s *statusStore) report(id string, faces []Face, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cams[id]
	if c == nil {
		return
	}
	c.at = time.Now()
	if err != nil {
		c.OK, c.Error = false, err.Error()
		return
	}
	if faces == nil {
		faces = []Face{}
	}
	c.OK, c.Error, c.Faces = true, "", faces
}

func (s *statusStore) snapshot() []camState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]camState, 0, len(s.cams))
	for _, c := range s.cams {
		v := *c
		if !v.at.IsZero() {
			v.AgeMs = time.Since(v.at).Milliseconds()
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

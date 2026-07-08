package snapshots

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ErrNotFound wird geliefert, wenn kein Snapshot mit dieser ID existiert.
var ErrNotFound = errors.New("snapshots: not found")

// Store liest/schreibt Snapshots als eine JSON-Datei pro Snapshot
// unterhalb von dir. IDs werden serverseitig erzeugt (siehe service.go),
// daher keine Path-Traversal-Prüfung nötig wie bei layouts.Store
// (dortiger Name kommt vom Client).
type Store struct {
	dir string
}

// NewStore erstellt einen Store, der Dateien unterhalb von dir ablegt.
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

// Put speichert (oder überschreibt) einen Snapshot.
func (s *Store) Put(snap Snapshot) error {
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.path(snap.ID), data, 0o644)
}

// Get liest einen einzelnen Snapshot.
func (s *Store) Get(id string) (Snapshot, error) {
	data, err := os.ReadFile(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

// List liefert alle gespeicherten Snapshots, älteste zuerst.
func (s *Store) List() ([]Snapshot, error) {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Snapshot{}, nil
	}
	if err != nil {
		return nil, err
	}

	snaps := []Snapshot{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		if err != nil {
			continue
		}
		var snap Snapshot
		if err := json.Unmarshal(data, &snap); err != nil {
			continue
		}
		snaps = append(snaps, snap)
	}

	sort.Slice(snaps, func(i, j int) bool { return snaps[i].CreatedAt.Before(snaps[j].CreatedAt) })
	return snaps, nil
}

func (s *Store) path(id string) string {
	return filepath.Join(s.dir, id+".json")
}

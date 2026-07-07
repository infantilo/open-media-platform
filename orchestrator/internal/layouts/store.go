// Package layouts persistiert benannte Layout-Blobs (Positionen +
// Gruppenbaum der Flow-Editor-UI, UMSETZUNG.md B5) als JSON-Dateien.
// Der Orchestrator kennt die Struktur des Blobs nicht — reines
// Opak-Speichern, das Schema gehört der UI (ARCHITECTURE.md §4.5a: kein
// eigenes Datenmodell im Orchestrator). Datei-Backend zunächst,
// PostgreSQL folgt in Phase D (D1).
package layouts

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var (
	// ErrInvalidName wird geliefert, wenn der Layout-Name nicht dem
	// erlaubten Muster entspricht (Schutz vor Path-Traversal).
	ErrInvalidName = errors.New("layouts: invalid name")
	// ErrNotFound wird geliefert, wenn kein Layout mit diesem Namen existiert.
	ErrNotFound = errors.New("layouts: not found")
	// ErrInvalidJSON wird geliefert, wenn der zu speichernde Body kein
	// gültiges JSON ist.
	ErrInvalidJSON = errors.New("layouts: invalid JSON body")
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Store liest/schreibt Layout-Blobs unterhalb von dir.
type Store struct {
	dir string
}

// NewStore erstellt einen Store, der Dateien unterhalb von dir ablegt.
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

// Get liest den zuletzt gespeicherten Blob für name.
func (s *Store) Get(name string) (json.RawMessage, error) {
	if !namePattern.MatchString(name) {
		return nil, ErrInvalidName
	}
	data, err := os.ReadFile(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

// Put speichert data unter name (überschreibt einen bestehenden Blob).
func (s *Store) Put(name string, data json.RawMessage) error {
	if !namePattern.MatchString(name) {
		return ErrInvalidName
	}
	if !json.Valid(data) {
		return ErrInvalidJSON
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.path(name), data, 0o644)
}

func (s *Store) path(name string) string {
	return filepath.Join(s.dir, name+".json")
}

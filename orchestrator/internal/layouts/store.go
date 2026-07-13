// Package layouts persistiert benannte Layout-Blobs (Positionen +
// Gruppenbaum der Flow-Editor-UI, UMSETZUNG.md B5) in PostgreSQL
// (UMSETZUNG.md D1, ersetzt das ursprüngliche Datei-Backend). Der
// Orchestrator kennt die Struktur des Blobs weiterhin nicht — reines
// Opak-Speichern in einer JSONB-Spalte, das Schema gehört der UI
// (ARCHITECTURE.md §4.5a: kein eigenes Datenmodell im Orchestrator).
package layouts

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
)

var (
	// ErrInvalidName wird geliefert, wenn der Layout-Name nicht dem
	// erlaubten Muster entspricht (Schutz vor z. B. Path-Traversal-
	// artigen Namen — historisch aus dem Datei-Backend übernommen, gilt
	// unverändert als Eingabevalidierung, auch ohne Dateisystempfad).
	ErrInvalidName = errors.New("layouts: invalid name")
	// ErrNotFound wird geliefert, wenn kein Layout mit diesem Namen existiert.
	ErrNotFound = errors.New("layouts: not found")
	// ErrInvalidJSON wird geliefert, wenn der zu speichernde Body kein
	// gültiges JSON ist.
	ErrInvalidJSON = errors.New("layouts: invalid JSON body")
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Store liest/schreibt Layout-Blobs in der `layouts`-Tabelle
// (internal/db/migrations/0001_init.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung (internal/db.Connect + db.Migrate, main.go).
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

// Get liest den zuletzt gespeicherten Blob für name.
func (s *Store) Get(name string) (json.RawMessage, error) {
	if !namePattern.MatchString(name) {
		return nil, ErrInvalidName
	}
	var data json.RawMessage
	err := s.db.QueryRow(`SELECT data FROM layouts WHERE name = $1`, name).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

// Put speichert data unter name (überschreibt einen bestehenden Blob).
func (s *Store) Put(name string, data json.RawMessage) error {
	if !namePattern.MatchString(name) {
		return ErrInvalidName
	}
	if !json.Valid(data) {
		return ErrInvalidJSON
	}
	_, err := s.db.Exec(`
		INSERT INTO layouts (name, data, updated_at) VALUES ($1, $2, now())
		ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
	`, name, []byte(data))
	return err
}

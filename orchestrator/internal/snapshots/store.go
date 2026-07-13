package snapshots

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// ErrNotFound wird geliefert, wenn kein Snapshot mit dieser ID existiert.
var ErrNotFound = errors.New("snapshots: not found")

// Store liest/schreibt Snapshots in der `snapshots`-Tabelle
// (internal/db/migrations/0001_init.sql, UMSETZUNG.md D1 — ersetzt das
// ursprüngliche Datei-Backend, eine JSON-Datei pro Snapshot). `created_at`
// ist eine echte Spalte (statt nur Teil des JSONB-Blobs), weil List()
// danach sortiert — ein Index darauf ersetzt das frühere In-Memory-Sort
// über alle gelesenen Dateien.
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung (internal/db.Connect + db.Migrate, main.go).
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

// Put speichert (oder überschreibt) einen Snapshot.
func (s *Store) Put(snap Snapshot) error {
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO snapshots (id, created_at, data) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, data = EXCLUDED.data
	`, snap.ID, snap.CreatedAt, data)
	return err
}

// Get liest einen einzelnen Snapshot.
func (s *Store) Get(id string) (Snapshot, error) {
	var data []byte
	err := s.db.QueryRow(`SELECT data FROM snapshots WHERE id = $1`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
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
	rows, err := s.db.Query(`SELECT data FROM snapshots ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snaps := []Snapshot{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var snap Snapshot
		if err := json.Unmarshal(data, &snap); err != nil {
			continue
		}
		snaps = append(snaps, snap)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return snaps, nil
}

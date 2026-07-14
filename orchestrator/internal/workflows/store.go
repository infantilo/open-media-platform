package workflows

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// ErrNotFound wird geliefert, wenn kein Workflow mit dieser ID existiert.
var ErrNotFound = errors.New("workflows: not found")

// Store liest/schreibt Workflows in der `workflows`-Tabelle
// (internal/db/migrations/0004_workflows.sql) — ein Blob pro Workflow,
// gleiches Muster wie internal/snapshots.Store.
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

// Put speichert (oder überschreibt) einen Workflow.
func (s *Store) Put(wf Workflow) error {
	data, err := json.Marshal(wf)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO workflows (id, status, updated_at, data) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data
	`, wf.ID, wf.Status, wf.UpdatedAt, data)
	return err
}

// Get liest einen einzelnen Workflow.
func (s *Store) Get(id string) (Workflow, error) {
	var data []byte
	err := s.db.QueryRow(`SELECT data FROM workflows WHERE id = $1`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return Workflow{}, ErrNotFound
	}
	if err != nil {
		return Workflow{}, err
	}
	var wf Workflow
	if err := json.Unmarshal(data, &wf); err != nil {
		return Workflow{}, err
	}
	return wf, nil
}

// List liefert alle gespeicherten Workflows, älteste zuerst.
func (s *Store) List() ([]Workflow, error) {
	rows, err := s.db.Query(`SELECT data FROM workflows ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Workflow{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var wf Workflow
		if err := json.Unmarshal(data, &wf); err != nil {
			continue
		}
		out = append(out, wf)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete entfernt einen Workflow. Kein Fehler, wenn er nicht existiert
// (idempotent, gleiches Muster wie launcher.Stop bei unbekannter ID).
func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM workflows WHERE id = $1`, id)
	return err
}

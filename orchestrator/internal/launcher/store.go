package launcher

import (
	"database/sql"
	"encoding/json"
)

// Store liest/schreibt Node-Instanzen in der `instances`-Tabelle
// (internal/db/migrations/0005_instances.sql, S4 — docs/REVIEW-2026-07-17-
// SKALIERUNG-24-7.md) — ersetzt das bisherige data/instances.json
// (UMSETZUNG.md C8). Ein Blob pro Instanz, gleiches Muster wie
// internal/workflows.Store.
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

// Put speichert (oder überschreibt) eine Instanz.
func (s *Store) Put(inst Instance) error {
	data, err := json.Marshal(inst)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO instances (id, data) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
	`, inst.ID, data)
	return err
}

// Delete entfernt eine Instanz. Kein Fehler, wenn sie nicht existiert
// (idempotent, gleiches Muster wie Launcher.Stop bei unbekannter ID).
func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM instances WHERE id = $1`, id)
	return err
}

// List liefert alle gespeicherten Instanzen (keine Reihenfolge-Garantie
// — Launcher.loadState filtert per PID-Check, sortiert nichts).
func (s *Store) List() ([]Instance, error) {
	rows, err := s.db.Query(`SELECT data FROM instances`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Instance{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var inst Instance
		if err := json.Unmarshal(data, &inst); err != nil {
			continue
		}
		out = append(out, inst)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

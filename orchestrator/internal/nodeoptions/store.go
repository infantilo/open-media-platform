package nodeoptions

import "database/sql"

// Scope eines gespeicherten Werts.
const (
	ScopeType     = "type"
	ScopeInstance = "instance"
)

// Store speichert Optionswerte (Tabelle node_option_values).
type Store struct{ db *sql.DB }

// NewStore erstellt den Speicher auf einer migrierten Datenbank.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Values liefert alle Werte eines Scopes/Subjekts (Schlüssel → Wert).
func (s *Store) Values(scope, subject string) (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM node_option_values WHERE scope = $1 AND subject = $2`, scope, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// AllInstanceValues liefert die Werte ALLER Instanzen (Instanz-ID → Schlüssel → Wert).
func (s *Store) AllInstanceValues() (map[string]map[string]string, error) {
	rows, err := s.db.Query(`SELECT subject, key, value FROM node_option_values WHERE scope = 'instance'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]string{}
	for rows.Next() {
		var id, k, v string
		if err := rows.Scan(&id, &k, &v); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]string{}
		}
		out[id][k] = v
	}
	return out, rows.Err()
}

// Set speichert einen Wert; value == "" löscht den Eintrag (zurück zum Standard).
func (s *Store) Set(scope, subject, key, value, by string) error {
	if value == "" {
		_, err := s.db.Exec(`DELETE FROM node_option_values WHERE scope = $1 AND subject = $2 AND key = $3`, scope, subject, key)
		return err
	}
	_, err := s.db.Exec(
		`INSERT INTO node_option_values (scope, subject, key, value, updated_by) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (scope, subject, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		scope, subject, key, value, by)
	return err
}

// DeleteInstance entfernt alle Werte einer Instanz (beim Löschen der Instanz).
func (s *Store) DeleteInstance(instanceID string) error {
	_, err := s.db.Exec(`DELETE FROM node_option_values WHERE scope = 'instance' AND subject = $1`, instanceID)
	return err
}

// MoveInstance überträgt alle Instanz-Werte auf eine neue Instanz-ID (Neustart per
// Stop + Start vergibt eine neue ID; die Einstellungen sollen mitgehen).
func (s *Store) MoveInstance(from, to string) error {
	if from == to {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`INSERT INTO node_option_values (scope, subject, key, value, updated_by, updated_at)
		 SELECT scope, $2, key, value, updated_by, updated_at FROM node_option_values WHERE scope = 'instance' AND subject = $1
		 ON CONFLICT (scope, subject, key) DO UPDATE SET value = EXCLUDED.value`, from, to); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM node_option_values WHERE scope = 'instance' AND subject = $1`, from); err != nil {
		return err
	}
	return tx.Commit()
}

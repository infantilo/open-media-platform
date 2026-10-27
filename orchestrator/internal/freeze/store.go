package freeze

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Meta beschreibt eine eingefrorene Momentaufnahme (ohne Inhalt).
type Meta struct {
	ID            string    `json:"id"`
	CreatedAt     time.Time `json:"createdAt"`
	CreatedBy     string    `json:"createdBy,omitempty"`
	Trigger       string    `json:"trigger"` // "manual" | "auto"
	Reason        string    `json:"reason,omitempty"`
	Note          string    `json:"note,omitempty"`
	WindowMinutes int       `json:"windowMinutes"`
	Scope         []string  `json:"scope,omitempty"` // Node-IDs, für die der Pipeline-Zustand festgehalten wurde (leer = alle)
	SizeBytes     int       `json:"sizeBytes"`
}

const (
	// MaxKept: so viele Momentaufnahmen bleiben insgesamt, MaxAutoKept davon automatisch angelegte (sonst verdrängt ein Dauerfehler die
	// von Hand angelegten).
	MaxKept     = 30
	MaxAutoKept = 10
	// RetentionDays: danach wird gelöscht.
	RetentionDays = 30
	// MaxBytes: größer als das wird nicht gespeichert (die Datenbank ist kein Dateispeicher).
	MaxBytes = 12 << 20
)

var (
	ErrTooLarge = errors.New("freeze: snapshot too large")
	ErrUnknown  = errors.New("freeze: unknown snapshot")
)

// Store legt die Momentaufnahmen in der Datenbank ab.
type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create speichert eine Momentaufnahme und räumt auf: älter als RetentionDays, mehr als MaxKept, mehr als MaxAutoKept automatische.
func (s *Store) Create(ctx context.Context, m Meta, data []byte) error {
	if len(data) > MaxBytes {
		return ErrTooLarge
	}
	scope, _ := json.Marshal(m.Scope)
	if m.Scope == nil {
		scope = []byte("[]")
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO freezes (id, created_at, created_by, trigger, reason, note, window_minutes, scope, size_bytes, data)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, m.ID, m.CreatedAt.UTC(), m.CreatedBy, m.Trigger, m.Reason, m.Note, m.WindowMinutes, string(scope), len(data), data); err != nil {
		return err
	}
	return s.prune(ctx)
}

func (s *Store) prune(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM freezes WHERE created_at < now() - ($1 * interval '1 day')`, RetentionDays); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM freezes WHERE trigger = 'auto' AND id NOT IN
		(SELECT id FROM freezes WHERE trigger = 'auto' ORDER BY created_at DESC LIMIT $1)`, MaxAutoKept); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM freezes WHERE id NOT IN (SELECT id FROM freezes ORDER BY created_at DESC LIMIT $1)`, MaxKept)
	return err
}

func scanMeta(row interface{ Scan(...any) error }) (Meta, error) {
	var m Meta
	var scope string
	if err := row.Scan(&m.ID, &m.CreatedAt, &m.CreatedBy, &m.Trigger, &m.Reason, &m.Note, &m.WindowMinutes, &scope, &m.SizeBytes); err != nil {
		return Meta{}, err
	}
	_ = json.Unmarshal([]byte(scope), &m.Scope)
	return m, nil
}

const metaCols = `id, created_at, created_by, trigger, reason, note, window_minutes, scope, size_bytes`

// List liefert die Momentaufnahmen ohne Inhalt, neueste zuerst.
func (s *Store) List(ctx context.Context, limit int) ([]Meta, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+metaCols+` FROM freezes ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Meta
	for rows.Next() {
		m, err := scanMeta(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Get liefert eine Momentaufnahme samt ZIP.
func (s *Store) Get(ctx context.Context, id string) (Meta, []byte, error) {
	var data []byte
	var m Meta
	var scope string
	err := s.db.QueryRowContext(ctx, `SELECT `+metaCols+`, data FROM freezes WHERE id = $1`, id).
		Scan(&m.ID, &m.CreatedAt, &m.CreatedBy, &m.Trigger, &m.Reason, &m.Note, &m.WindowMinutes, &scope, &m.SizeBytes, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return Meta{}, nil, ErrUnknown
	}
	if err != nil {
		return Meta{}, nil, err
	}
	_ = json.Unmarshal([]byte(scope), &m.Scope)
	return m, data, nil
}

// Delete löscht eine Momentaufnahme.
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM freezes WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknown
	}
	return nil
}

package mcr

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

func newID() string { return tracing.NewID() }

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// obj: leeres JSON wird zu `{}` (Spalten mit NOT NULL DEFAULT '{}').
func obj(raw json.RawMessage) []byte {
	if len(raw) == 0 || string(raw) == "null" {
		return []byte("{}")
	}
	return raw
}

// nullable: leeres JSON wird zu NULL (Hausformat nicht gesetzt).
func nullable(raw json.RawMessage) any {
	h, _ := ParseHouse(raw)
	if h == nil {
		return nil
	}
	b, _ := json.Marshal(h)
	return b
}

func rawOrNil(b []byte) json.RawMessage {
	if len(b) == 0 {
		return nil
	}
	return json.RawMessage(b)
}

// ---- Vorlagen ----

func (s *Store) ListTemplates(ctx context.Context) ([]Template, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, lines, house_format, created_by, created_at, updated_at FROM mcr_templates ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

type scanner interface{ Scan(dest ...any) error }

func scanTemplate(r scanner) (Template, error) {
	var t Template
	var lines, house []byte
	if err := r.Scan(&t.ID, &t.Name, &t.Description, &lines, &house, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return t, err
	}
	_ = json.Unmarshal(lines, &t.Lines)
	if t.Lines == nil {
		t.Lines = []Line{}
	}
	t.HouseFormat = rawOrNil(house)
	return t, nil
}

func (s *Store) GetTemplate(ctx context.Context, id string) (Template, error) {
	t, err := scanTemplate(s.db.QueryRowContext(ctx, `SELECT id, name, description, lines, house_format, created_by, created_at, updated_at FROM mcr_templates WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

func (s *Store) CreateTemplate(ctx context.Context, t Template, actor string) (Template, error) {
	t.ID = newID()
	lines, _ := json.Marshal(t.Lines)
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcr_templates (id, name, description, lines, house_format, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
		t.ID, t.Name, t.Description, lines, nullable(t.HouseFormat), actor)
	if err != nil {
		return t, err
	}
	return s.GetTemplate(ctx, t.ID)
}

func (s *Store) UpdateTemplate(ctx context.Context, t Template) (Template, error) {
	lines, _ := json.Marshal(t.Lines)
	res, err := s.db.ExecContext(ctx, `UPDATE mcr_templates SET name=$2, description=$3, lines=$4, house_format=$5, updated_at=now() WHERE id=$1`,
		t.ID, t.Name, t.Description, lines, nullable(t.HouseFormat))
	if err != nil {
		return t, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return t, ErrNotFound
	}
	return s.GetTemplate(ctx, t.ID)
}

func (s *Store) DeleteTemplate(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM mcr_templates WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Events ----

const eventCols = `id, name, template_id, state, planned_start, planned_end, workflow_id, owner, owner_group, house_format, warnings, created_by, created_at, updated_at`

func scanEvent(r scanner) (Event, error) {
	var e Event
	var house, warn []byte
	var ps, pe sql.NullTime
	if err := r.Scan(&e.ID, &e.Name, &e.TemplateID, &e.State, &ps, &pe, &e.WorkflowID, &e.Owner, &e.OwnerGroup, &house, &warn, &e.CreatedBy, &e.CreatedAt, &e.UpdatedAt); err != nil {
		return e, err
	}
	_ = json.Unmarshal(warn, &e.Warnings)
	if e.Warnings == nil {
		e.Warnings = []string{}
	}
	if ps.Valid {
		t := ps.Time
		e.PlannedStart = &t
	}
	if pe.Valid {
		t := pe.Time
		e.PlannedEnd = &t
	}
	e.HouseFormat = rawOrNil(house)
	e.Lines, e.Members = []Line{}, []Member{}
	return e, nil
}

func (s *Store) loadChildren(ctx context.Context, e *Event) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, kind, transport, normalize, avsync, record, intercom, house_format, position FROM mcr_lines WHERE event_id=$1 ORDER BY position, id`, e.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var l Line
		var tr, no, av, rc, ic, hf []byte
		if err := rows.Scan(&l.ID, &l.Name, &l.Kind, &tr, &no, &av, &rc, &ic, &hf, &l.Position); err != nil {
			return err
		}
		l.Transport, l.Normalize, l.Avsync, l.Record, l.Intercom, l.HouseFormat = rawOrNil(tr), rawOrNil(no), rawOrNil(av), rawOrNil(rc), rawOrNil(ic), rawOrNil(hf)
		e.Lines = append(e.Lines, l)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	mrows, err := s.db.QueryContext(ctx, `SELECT subject_type, subject, event_role FROM mcr_members WHERE event_id=$1 ORDER BY subject_type, subject`, e.ID)
	if err != nil {
		return err
	}
	defer mrows.Close()
	for mrows.Next() {
		var m Member
		if err := mrows.Scan(&m.SubjectType, &m.Subject, &m.Role); err != nil {
			return err
		}
		e.Members = append(e.Members, m)
	}
	return mrows.Err()
}

func (s *Store) GetEvent(ctx context.Context, id string) (Event, error) {
	e, err := scanEvent(s.db.QueryRowContext(ctx, `SELECT `+eventCols+` FROM mcr_events WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	if err != nil {
		return e, err
	}
	return e, s.loadChildren(ctx, &e)
}

// ListEvents: ohne Kinder (Übersicht); `state` leer = alle.
func (s *Store) ListEvents(ctx context.Context, state string) ([]Event, error) {
	q := `SELECT ` + eventCols + ` FROM mcr_events`
	args := []any{}
	if state != "" {
		q += ` WHERE state=$1`
		args = append(args, state)
	}
	q += ` ORDER BY planned_start NULLS LAST, created_at`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func insertLines(ctx context.Context, tx *sql.Tx, eventID string, lines []Line) error {
	for i, l := range lines {
		_, err := tx.ExecContext(ctx, `INSERT INTO mcr_lines (event_id, id, name, kind, transport, normalize, avsync, record, intercom, house_format, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			eventID, l.ID, l.Name, l.Kind, obj(l.Transport), obj(l.Normalize), obj(l.Avsync), obj(l.Record), obj(l.Intercom), nullable(l.HouseFormat), i)
		if err != nil {
			return err
		}
	}
	return nil
}

func insertMembers(ctx context.Context, tx *sql.Tx, eventID string, ms []Member) error {
	for _, m := range ms {
		if _, err := tx.ExecContext(ctx, `INSERT INTO mcr_members (event_id, subject_type, subject, event_role) VALUES ($1,$2,$3,$4)`, eventID, m.SubjectType, m.Subject, m.Role); err != nil {
			return err
		}
	}
	return nil
}

// CreateEvent legt Event, Leitungen und Mitglieder in einer Transaktion an (Zustand immer `planned`).
func (s *Store) CreateEvent(ctx context.Context, e Event, actor string) (Event, error) {
	e.ID = newID()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return e, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO mcr_events (id, name, template_id, state, planned_start, planned_end, owner, owner_group, house_format, created_by) VALUES ($1,$2,$3,'planned',$4,$5,$6,$7,$8,$9)`,
		e.ID, e.Name, e.TemplateID, e.PlannedStart, e.PlannedEnd, e.Owner, e.OwnerGroup, nullable(e.HouseFormat), actor)
	if err != nil {
		return e, err
	}
	if err := insertLines(ctx, tx, e.ID, e.Lines); err != nil {
		return e, err
	}
	if err := insertMembers(ctx, tx, e.ID, e.Members); err != nil {
		return e, err
	}
	if err := tx.Commit(); err != nil {
		return e, err
	}
	return s.GetEvent(ctx, e.ID)
}

// UpdateEvent ersetzt die Stammdaten und, wenn `lines` nicht nil ist, alle Leitungen.
func (s *Store) UpdateEvent(ctx context.Context, e Event, replaceLines bool) (Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return e, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE mcr_events SET name=$2, planned_start=$3, planned_end=$4, owner=$5, owner_group=$6, house_format=$7, updated_at=now() WHERE id=$1`,
		e.ID, e.Name, e.PlannedStart, e.PlannedEnd, e.Owner, e.OwnerGroup, nullable(e.HouseFormat))
	if err != nil {
		return e, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return e, ErrNotFound
	}
	if replaceLines {
		if _, err := tx.ExecContext(ctx, `DELETE FROM mcr_lines WHERE event_id=$1`, e.ID); err != nil {
			return e, err
		}
		if err := insertLines(ctx, tx, e.ID, e.Lines); err != nil {
			return e, err
		}
	}
	if err := tx.Commit(); err != nil {
		return e, err
	}
	return s.GetEvent(ctx, e.ID)
}

func (s *Store) ReplaceMembers(ctx context.Context, eventID string, ms []Member) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM mcr_members WHERE event_id=$1`, eventID); err != nil {
		return err
	}
	if err := insertMembers(ctx, tx, eventID, ms); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE mcr_events SET updated_at=now() WHERE id=$1`, eventID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetState wechselt den Zustand nur, wenn er noch `from` ist (kein verlorenes Update bei gleichzeitigen Aufrufen).
func (s *Store) SetState(ctx context.Context, id, from, to string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE mcr_events SET state=$3, updated_at=now() WHERE id=$1 AND state=$2`, id, from, to)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrState
	}
	return nil
}

func (s *Store) SetWorkflow(ctx context.Context, id, workflowID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE mcr_events SET workflow_id=$2, updated_at=now() WHERE id=$1`, id, workflowID)
	return err
}

func (s *Store) DeleteEvent(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM mcr_events WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

var _ = time.Second

func (s *Store) SetLineAvsync(ctx context.Context, eventID, lineID string, raw json.RawMessage) error {
	res, err := s.db.ExecContext(ctx, `UPDATE mcr_lines SET avsync=$3 WHERE event_id=$1 AND id=$2`, eventID, lineID, obj(raw))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// EventOfInstance: findet Event und Leitung zu einer Normalizer-Rolleninstanz über die Workflow-ID (für Beobachter).
func (s *Store) ActiveEvents(ctx context.Context) ([]Event, error) {
	var out []Event
	for _, st := range []string{StateTesting, StateLive} {
		evs, err := s.ListEvents(ctx, st)
		if err != nil {
			return nil, err
		}
		for _, e := range evs {
			full, err := s.GetEvent(ctx, e.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, full)
		}
	}
	return out, nil
}

// SetWarnings ersetzt die Warnungen des Events (nur schreiben, wenn sie sich geändert haben).
func (s *Store) SetWarnings(ctx context.Context, id string, w []string) error {
	if w == nil {
		w = []string{}
	}
	b, _ := json.Marshal(w)
	_, err := s.db.ExecContext(ctx, `UPDATE mcr_events SET warnings=$2 WHERE id=$1 AND warnings IS DISTINCT FROM $2::jsonb`, id, b)
	return err
}

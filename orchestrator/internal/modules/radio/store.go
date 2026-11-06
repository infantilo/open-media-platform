package radio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// keepVersions: so viele Stände je Sendung bleiben erhalten (die ältesten werden gelöscht).
const keepVersions = 50

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func newID() string { return tracing.NewID() }

func mj(v any) []byte { b, _ := json.Marshal(v); return b }

const showCols = `id, title, description, template, status, slot_start, slot_end, presenters, owner, tags, row_version, created_by, updated_by, created_at, updated_at, recurrence, source_template_id, auto_live`

func scanShow(r interface{ Scan(...any) error }, withContent bool) (Show, error) {
	var s Show
	var ss, se sql.NullTime
	var pr, tg, content, rec []byte
	dest := []any{&s.ID, &s.Title, &s.Description, &s.Template, &s.Status, &ss, &se, &pr, &s.Owner, &tg, &s.RowVersion, &s.CreatedBy, &s.UpdatedBy, &s.CreatedAt, &s.UpdatedAt, &rec, &s.SourceTemplateID, &s.AutoLive}
	if withContent {
		dest = append(dest, &content)
	}
	if err := r.Scan(dest...); err != nil {
		return s, err
	}
	if ss.Valid {
		t := ss.Time
		s.SlotStart = &t
	}
	if se.Valid {
		t := se.Time
		s.SlotEnd = &t
	}
	if len(rec) > 0 && string(rec) != "null" {
		s.Recurrence = rec
	}
	_ = json.Unmarshal(pr, &s.Presenters)
	_ = json.Unmarshal(tg, &s.Tags)
	if s.Presenters == nil {
		s.Presenters = []string{}
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	if withContent {
		s.Content = content
	}
	return s, nil
}

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func nullJSON(r json.RawMessage) any {
	if len(r) == 0 || string(r) == "null" {
		return nil
	}
	return []byte(r)
}

func contentOrEmpty(c json.RawMessage) []byte {
	if len(c) == 0 {
		return []byte("{}")
	}
	return c
}

// Filter für die Liste.
type Filter struct {
	Status   string
	Template *bool
	From, To *time.Time // Zeitfenster überschneidet [From, To)
	User     string     // nur Sendungen, die die Person besitzt oder moderiert
}

// List liefert Sendungen ohne Inhalt, nach Beginn aufsteigend (Vorlagen und ungeplante zuletzt nach Titel).
func (s *Store) List(ctx context.Context, f Filter) ([]Show, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", fmt.Sprintf("$%d", len(args))))
	}
	if f.Status != "" {
		add("status = ?", f.Status)
	}
	if f.Template != nil {
		add("template = ?", *f.Template)
	}
	if f.From != nil {
		add("(slot_end IS NULL OR slot_end > ?)", *f.From)
	}
	if f.To != nil {
		add("(slot_start IS NULL OR slot_start < ?)", *f.To)
	}
	if f.User != "" {
		args = append(args, f.User, string(mj([]string{f.User})))
		where = append(where, fmt.Sprintf("(owner = $%d OR presenters @> $%d::jsonb)", len(args)-1, len(args)))
	}
	q := `SELECT ` + showCols + ` FROM radio_shows`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY slot_start NULLS LAST, title LIMIT 1000`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Show{}
	for rows.Next() {
		sh, err := scanShow(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// Get liefert eine Sendung mit Inhalt.
func (s *Store) Get(ctx context.Context, id string) (Show, error) {
	sh, err := scanShow(s.db.QueryRowContext(ctx, `SELECT `+showCols+`, content FROM radio_shows WHERE id=$1`, id), true)
	if errors.Is(err, sql.ErrNoRows) {
		return sh, ErrNotFound
	}
	return sh, err
}

func (s *Store) addVersion(ctx context.Context, tx *sql.Tx, id string, version int, reason, by string, content []byte) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO radio_show_versions (show_id, version, reason, created_by, content) VALUES ($1,$2,$3,$4,$5)`, id, version, reason, by, content); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM radio_show_versions WHERE show_id=$1 AND version <= $2`, id, version-keepVersions)
	return err
}

// Create legt eine Sendung an (Status Entwurf, Version 1).
func (s *Store) Create(ctx context.Context, in Input, actor string) (Show, error) {
	if err := in.Validate(); err != nil {
		return Show{}, err
	}
	id := newID()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Show{}, err
	}
	defer tx.Rollback()
	c := contentOrEmpty(in.Content)
	if _, err := tx.ExecContext(ctx, `INSERT INTO radio_shows (id, title, description, template, slot_start, slot_end, presenters, owner, tags, content, created_by, updated_by, recurrence, auto_live, source_template_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14)`, id, strings.TrimSpace(in.Title), in.Description, in.Template, nullTime(in.SlotStart), nullTime(in.SlotEnd),
		mj(cleanList(in.Presenters)), actor, mj(cleanList(in.Tags)), c, actor, nullJSON(in.Recurrence), in.AutoLive == nil || *in.AutoLive, in.sourceTemplate); err != nil {
		return Show{}, err
	}
	if err := s.addVersion(ctx, tx, id, 1, firstNonEmpty(in.Reason, "angelegt"), actor, c); err != nil {
		return Show{}, err
	}
	if err := tx.Commit(); err != nil {
		return Show{}, err
	}
	return s.Get(ctx, id)
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return strings.TrimSpace(a)
	}
	return b
}

// Update ändert eine Sendung (nur Entwurf und freigegebene; eine laufende oder gesendete wird nicht überschrieben).
// `in.RowVersion` muss dem aktuellen Stand entsprechen, sonst ErrConflict.
func (s *Store) Update(ctx context.Context, id string, in Input, actor string) (Show, error) {
	if err := in.Validate(); err != nil {
		return Show{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Show{}, err
	}
	defer tx.Rollback()
	var status string
	var cur int
	err = tx.QueryRowContext(ctx, `SELECT status, row_version FROM radio_shows WHERE id=$1 FOR UPDATE`, id).Scan(&status, &cur)
	if errors.Is(err, sql.ErrNoRows) {
		return Show{}, ErrNotFound
	}
	if err != nil {
		return Show{}, err
	}
	if in.RowVersion != cur {
		return Show{}, ErrConflict
	}
	if status == StatusLive || status == StatusDone || status == StatusArchived {
		return Show{}, fmt.Errorf("%w: eine Sendung im Status „%s“ wird nicht geändert", ErrState, status)
	}
	c := contentOrEmpty(in.Content)
	next := cur + 1
	if _, err := tx.ExecContext(ctx, `UPDATE radio_shows SET title=$2, description=$3, template=$4, slot_start=$5, slot_end=$6, presenters=$7, tags=$8, content=$9,
		row_version=$10, updated_by=$11, updated_at=now(), recurrence=$12, auto_live=COALESCE($13::boolean, auto_live) WHERE id=$1`, id, strings.TrimSpace(in.Title), in.Description, in.Template, nullTime(in.SlotStart), nullTime(in.SlotEnd),
		mj(cleanList(in.Presenters)), mj(cleanList(in.Tags)), c, next, actor, nullJSON(in.Recurrence), in.AutoLive); err != nil {
		return Show{}, err
	}
	if err := s.addVersion(ctx, tx, id, next, in.Reason, actor, c); err != nil {
		return Show{}, err
	}
	if err := tx.Commit(); err != nil {
		return Show{}, err
	}
	return s.Get(ctx, id)
}

// SetStatus wechselt den Status nach der Übergangstabelle.
func (s *Store) SetStatus(ctx context.Context, id, to, actor string) (Show, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return Show{}, err
	}
	if cur.Template {
		return Show{}, fmt.Errorf("%w: eine Vorlage hat keinen Sendestatus", ErrState)
	}
	if !canTransition(cur.Status, to) {
		return Show{}, fmt.Errorf("%w: %s → %s", ErrState, cur.Status, to)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE radio_shows SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND status=$4`, id, to, actor, cur.Status)
	if err != nil {
		return Show{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Show{}, ErrConflict
	}
	return s.Get(ctx, id)
}

// Delete löscht eine Sendung samt Versionen (nicht, solange sie läuft).
func (s *Store) Delete(ctx context.Context, id string) error {
	// Eine aus einer Vorlage erzeugte Sendung wird nicht von der Wiederkehr neu angelegt
	_, _ = s.db.ExecContext(ctx, `INSERT INTO radio_show_skips (source_template_id, slot_start) SELECT source_template_id, slot_start FROM radio_shows WHERE id=$1 AND source_template_id <> '' AND slot_start IS NOT NULL ON CONFLICT DO NOTHING`, id)
	res, err := s.db.ExecContext(ctx, `DELETE FROM radio_shows WHERE id=$1 AND status <> 'live'`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, gerr := s.Get(ctx, id); gerr != nil {
			return gerr
		}
		return fmt.Errorf("%w: eine laufende Sendung wird nicht gelöscht", ErrState)
	}
	return nil
}

// Versions listet die Stände (neueste zuerst, ohne Inhalt).
func (s *Store) Versions(ctx context.Context, id string) ([]Version, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT show_id, version, reason, created_by, created_at FROM radio_show_versions WHERE show_id=$1 ORDER BY version DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		if err := rows.Scan(&v.ShowID, &v.Version, &v.Reason, &v.CreatedBy, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetVersion liefert einen Stand mit Inhalt.
func (s *Store) GetVersion(ctx context.Context, id string, version int) (Version, error) {
	var v Version
	var c []byte
	err := s.db.QueryRowContext(ctx, `SELECT show_id, version, reason, created_by, created_at, content FROM radio_show_versions WHERE show_id=$1 AND version=$2`, id, version).
		Scan(&v.ShowID, &v.Version, &v.Reason, &v.CreatedBy, &v.CreatedAt, &c)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	v.Content = c
	return v, err
}

// Duplicate legt aus einer Sendung oder Vorlage eine neue an (`template` bestimmt, ob das Ergebnis Vorlage ist; Zeitfenster aus `in`).
func (s *Store) Duplicate(ctx context.Context, id string, in Input, actor string) (Show, error) {
	src, err := s.Get(ctx, id)
	if err != nil {
		return Show{}, err
	}
	n := Input{Title: in.Title, Description: src.Description, Template: in.Template, SlotStart: in.SlotStart, SlotEnd: in.SlotEnd,
		Presenters: src.Presenters, Tags: src.Tags, Content: src.Content, Reason: fmt.Sprintf("kopiert aus „%s“", src.Title)}
	if strings.TrimSpace(n.Title) == "" {
		n.Title = src.Title + " (Kopie)"
	}
	if len(in.Presenters) > 0 {
		n.Presenters = in.Presenters
	}
	return s.Create(ctx, n, actor)
}

// ---- Zeitsteuerung und Wiederkehr -----------------------------------------------------------------------------------

// RecurringTemplates liefert Vorlagen mit eingeschalteter Wiederkehr (mit Inhalt).
func (s *Store) RecurringTemplates(ctx context.Context) ([]Show, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+showCols+`, content FROM radio_shows WHERE template AND recurrence IS NOT NULL AND (recurrence->>'enabled')::boolean`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Show
	for rows.Next() {
		sh, err := scanShow(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// CreateOccurrence legt die Sendung zu einem Termin der Vorlage an — genau einmal je Vorlage und Beginn, nicht für gelöschte Termine.
// created=false: gab es schon oder wurde übersprungen.
func (s *Store) CreateOccurrence(ctx context.Context, tpl Show, o Occurrence, title string, actor string) (created bool, err error) {
	var skipped bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM radio_show_skips WHERE source_template_id=$1 AND slot_start=$2)`, tpl.ID, o.Start).Scan(&skipped); err != nil {
		return false, err
	}
	if skipped {
		return false, nil
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM radio_shows WHERE source_template_id=$1 AND slot_start=$2)`, tpl.ID, o.Start).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	start, end := o.Start, o.End
	auto := tpl.AutoLive
	in := Input{Title: title, Description: tpl.Description, SlotStart: &start, SlotEnd: &end, Presenters: tpl.Presenters, Tags: tpl.Tags, Content: tpl.Content,
		AutoLive: &auto, Reason: fmt.Sprintf("erzeugt aus Vorlage „%s“", tpl.Title), sourceTemplate: tpl.ID}
	if _, err := s.createOwned(ctx, in, tpl.Owner, actor); err != nil {
		if strings.Contains(err.Error(), "radio_shows_occurrence_idx") {
			return false, nil // parallel angelegt
		}
		return false, err
	}
	return true, nil
}

// createOwned wie Create, aber mit vorgegebenem Besitzer (die Vorlage gehört der Person, die sie angelegt hat).
func (s *Store) createOwned(ctx context.Context, in Input, owner, actor string) (Show, error) {
	sh, err := s.Create(ctx, in, actor)
	if err != nil {
		return sh, err
	}
	if owner != "" && owner != actor {
		_, _ = s.db.ExecContext(ctx, `UPDATE radio_shows SET owner=$2 WHERE id=$1`, sh.ID, owner)
		sh.Owner = owner
	}
	return sh, nil
}

// AutoTransitions schaltet nach dem Zeitfenster: freigegeben → live ab Beginn, live → gesendet ab Ende (nur Sendungen mit autoLive).
// Liefert die Sendungen, die gewechselt haben (id, von, nach).
func (s *Store) AutoTransitions(ctx context.Context, now time.Time, actor string) ([][3]string, error) {
	var out [][3]string
	run := func(from, to, cond string) error {
		rows, err := s.db.QueryContext(ctx, `UPDATE radio_shows SET status=$1, updated_by=$2, updated_at=now() WHERE NOT template AND auto_live AND status=$3 AND `+cond+` RETURNING id`, to, actor, from, now)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			out = append(out, [3]string{id, from, to})
		}
		return rows.Err()
	}
	// zuerst Ende (eine verpasste Sendung geht direkt auf done), dann Beginn
	if err := run(StatusLive, StatusDone, "slot_end IS NOT NULL AND slot_end <= $4"); err != nil {
		return out, err
	}
	if err := run(StatusReady, StatusLive, "slot_start IS NOT NULL AND slot_start <= $4 AND (slot_end IS NULL OR slot_end > $4)"); err != nil {
		return out, err
	}
	return out, nil
}

package accessrules

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrNotFound   = errors.New("accessrules: not found")
	ErrValidation = errors.New("accessrules: validation failed")
)

// Store speichert die Regeln (Tabelle access_rules) und hält sie im Speicher: die Liste ist klein, jede Änderung lädt sie neu.
type Store struct {
	db *sql.DB

	mu     sync.RWMutex
	cached []Rule
	loaded bool
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

const cols = `id, subject_type, subject, kind, action, effect, selector_type, selector_value, note, created_by, created_at`

func scan(row interface{ Scan(...any) error }) (Rule, error) {
	var r Rule
	var at time.Time
	err := row.Scan(&r.ID, &r.SubjectType, &r.Subject, &r.Kind, &r.Action, &r.Effect, &r.SelectorType, &r.SelectorValue, &r.Note, &r.CreatedBy, &at)
	r.CreatedAt = at.UTC().Format(time.RFC3339)
	return r, err
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// List liefert alle Regeln, ältere zuerst.
func (s *Store) List() ([]Rule, error) {
	s.mu.RLock()
	if s.loaded {
		out := append([]Rule(nil), s.cached...)
		s.mu.RUnlock()
		return out, nil
	}
	s.mu.RUnlock()
	return s.reload()
}

func (s *Store) reload() ([]Rule, error) {
	rows, err := s.db.Query(`SELECT ` + cols + ` FROM access_rules ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cached, s.loaded = out, true
	s.mu.Unlock()
	return append([]Rule(nil), out...), nil
}

// Create legt eine Regel an.
func (s *Store) Create(r Rule, createdBy string) (Rule, error) {
	if err := r.Validate(); err != nil {
		return Rule{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	id, err := newID()
	if err != nil {
		return Rule{}, err
	}
	_, err = s.db.Exec(`INSERT INTO access_rules (id, subject_type, subject, kind, action, effect, selector_type, selector_value, note, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		id, r.SubjectType, r.Subject, r.Kind, r.Action, r.Effect, r.SelectorType, r.SelectorValue, r.Note, createdBy)
	if err != nil {
		return Rule{}, err
	}
	if _, err := s.reload(); err != nil {
		return Rule{}, err
	}
	return s.Get(id)
}

// Get liest eine Regel.
func (s *Store) Get(id string) (Rule, error) {
	r, err := scan(s.db.QueryRow(`SELECT `+cols+` FROM access_rules WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Rule{}, ErrNotFound
	}
	return r, err
}

// Update ersetzt alle Felder außer ID und Urheber.
func (s *Store) Update(id string, r Rule) (Rule, error) {
	if err := r.Validate(); err != nil {
		return Rule{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	res, err := s.db.Exec(`UPDATE access_rules SET subject_type=$2, subject=$3, kind=$4, action=$5, effect=$6, selector_type=$7, selector_value=$8, note=$9 WHERE id=$1`,
		id, r.SubjectType, r.Subject, r.Kind, r.Action, r.Effect, r.SelectorType, r.SelectorValue, r.Note)
	if err != nil {
		return Rule{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Rule{}, ErrNotFound
	}
	if _, err := s.reload(); err != nil {
		return Rule{}, err
	}
	return s.Get(id)
}

// Delete entfernt eine Regel; keine Fehlermeldung, wenn es sie nicht gibt.
func (s *Store) Delete(id string) error {
	if _, err := s.db.Exec(`DELETE FROM access_rules WHERE id = $1`, id); err != nil {
		return err
	}
	_, err := s.reload()
	return err
}

// DeleteForSubject entfernt alle Regeln eines Nutzers bzw. einer Gruppe (beim Löschen des Kontos bzw. der Gruppe).
func (s *Store) DeleteForSubject(subjectType, subject string) error {
	if _, err := s.db.Exec(`DELETE FROM access_rules WHERE subject_type = $1 AND subject = $2`, subjectType, subject); err != nil {
		return err
	}
	_, err := s.reload()
	return err
}

// Engine wertet die Regeln für einen Nutzer aus.
type Engine struct {
	Store *Store
	// GroupIDs liefert die Gruppen-IDs eines Nutzers; nil = keine Gruppen.
	GroupIDs func(username string) []string
}

// PolicyFor baut die für username geltende Policy: globale Regeln, seine eigenen und die seiner Gruppen.
func (e *Engine) PolicyFor(username string) (*Policy, error) {
	all, err := e.Store.List()
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return NewPolicy(nil), nil
	}
	groups := map[string]bool{}
	if e.GroupIDs != nil {
		for _, g := range e.GroupIDs(username) {
			groups[g] = true
		}
	}
	var mine []Rule
	for _, r := range all {
		switch r.SubjectType {
		case SubjectGlobal:
			mine = append(mine, r)
		case SubjectUser:
			if r.Subject == username {
				mine = append(mine, r)
			}
		case SubjectGroup:
			if groups[r.Subject] {
				mine = append(mine, r)
			}
		}
	}
	return NewPolicy(mine), nil
}

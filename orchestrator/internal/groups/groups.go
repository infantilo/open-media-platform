// Package groups implementiert gruppenbasierte Rechteverwaltung
// (Nutzerauftrag 2026-09-24, im Anschluss an Kapitel 21: "dann gruppen
// basierte rechteverwaltung", auch als Vorbereitung für eine spätere
// Windows-Active-Directory-Anbindung — AD synchronisiert typischerweise
// Gruppenmitgliedschaft, nicht Einzelrechte, deshalb der Entwurf hier:
// Gruppen als eigener authz.Binding-Subject-Typ statt Ersatz für
// Einzelbindungen).
//
// BEWUSST unabhängig von internal/organizations (Kapitel 21 B14):
// Organisation ist eine reine Sichtbarkeits-/Mandanten-Grenze (welche
// Objekte sieht ein Nutzer überhaupt, org_enforcement.go), Gruppe ist
// eine reine Rechte-Bündelung (welche Verben hat ein Nutzer, über
// internal/authz.Binding statt Einzelbindungen). Beide Mechanismen
// bleiben unabhängig nebeneinander bestehen — eine Organisation wird
// durch Gruppen NICHT ersetzt, s. UMSETZUNG.md-Diskussion 2026-09-24.
package groups

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrNotFound   = errors.New("groups: not found")
	ErrValidation = errors.New("groups: validation failed")
)

// Group bündelt Rechte (über authz.Binding-Einträge mit
// SubjectType="group") für ihre Mitglieder.
type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("groups: id generation failed")
	}
	return id, nil
}

// Create legt eine neue Gruppe an.
func (s *Store) Create(name, description, createdBy string) (Group, error) {
	if name == "" {
		return Group{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return Group{}, err
	}
	now := time.Now().UTC()
	g := Group{ID: id, Name: name, Description: description, CreatedBy: createdBy, CreatedAt: now, UpdatedAt: now}
	_, err = s.db.Exec(`
		INSERT INTO groups (id, name, description, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)
	`, g.ID, g.Name, g.Description, g.CreatedBy, g.CreatedAt)
	if err != nil {
		return Group{}, err
	}
	return g, nil
}

func scanGroup(row interface{ Scan(...any) error }) (Group, error) {
	var g Group
	err := row.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedBy, &g.CreatedAt, &g.UpdatedAt)
	return g, err
}

const groupSelectColumns = `id, name, description, created_by, created_at, updated_at`

// Get liest eine einzelne Gruppe.
func (s *Store) Get(id string) (Group, error) {
	row := s.db.QueryRow(`SELECT `+groupSelectColumns+` FROM groups WHERE id = $1`, id)
	g, err := scanGroup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Group{}, ErrNotFound
	}
	return g, err
}

// List liefert alle Gruppen, alphabetisch — Nutzerauftrag "full
// overview", keine Pagination nötig bei der erwarteten Größenordnung.
func (s *Store) List() ([]Group, error) {
	rows, err := s.db.Query(`SELECT ` + groupSelectColumns + ` FROM groups ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// UpdateMeta ändert Name/Beschreibung.
func (s *Store) UpdateMeta(id, name, description string) (Group, error) {
	if name == "" {
		return Group{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	res, err := s.db.Exec(`UPDATE groups SET name = $2, description = $3, updated_at = now() WHERE id = $1`, id, name, description)
	if err != nil {
		return Group{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Group{}, ErrNotFound
	}
	return s.Get(id)
}

// CountBindings liefert, wie viele Rollenbindungen noch auf diese
// Gruppe verweisen (subject_type='group', subject=id) — role_bindings
// kann diese Beziehung nicht per Fremdschlüssel selbst schützen (s.
// Migrations-Doku: dieselbe Spalte trägt je nach subject_type
// unterschiedliche Referenzräume), Delete prüft deshalb hier vorab für
// eine konkrete Fehlermeldung, gleiches Muster wie
// storagebackends.Store.CountRepresentations.
func (s *Store) CountBindings(id string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM role_bindings WHERE subject_type = 'group' AND subject = $1`, id).Scan(&n)
	return n, err
}

// Delete entfernt eine Gruppe. cascadeBindings=true löscht zuerst ihre
// Rollenbindungen mit (bewusst KEIN reiner Fremdschlüssel-Fallback wie
// bei storagebackends/organizations: eine verwaiste Gruppen-Bindung ist
// nicht wie eine verwaiste Datei-Referenz gefährlich — sie wird beim
// nächsten Check() einfach wirkungslos, da group_members leer/die
// Gruppe weg ist — ein Kaskadieren ist hier also sicher und für "volle
// Kontrolle ohne Umweg über zwei Tabs" ausdrücklich erwünscht, statt
// wie bei Dateien einen harten Stopp zu erzwingen).
func (s *Store) Delete(id string, cascadeBindings bool) error {
	if cascadeBindings {
		if _, err := s.db.Exec(`DELETE FROM role_bindings WHERE subject_type = 'group' AND subject = $1`, id); err != nil {
			return err
		}
	}
	res, err := s.db.Exec(`DELETE FROM groups WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListMembers liefert die Nutzernamen einer Gruppe, alphabetisch.
func (s *Store) ListMembers(groupID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT username FROM group_members WHERE group_id = $1 ORDER BY username`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// AddMember fügt einen Nutzer hinzu — idempotent (ein zweiter Aufruf
// mit demselben Nutzer ist ein No-op, kein Konflikt), echter
// Fremdschlüssel auf users(username) lehnt einen erfundenen
// Nutzernamen ab (s. Migrations-Doku).
func (s *Store) AddMember(groupID, username string) error {
	_, err := s.db.Exec(`
		INSERT INTO group_members (group_id, username) VALUES ($1, $2)
		ON CONFLICT (group_id, username) DO NOTHING
	`, groupID, username)
	return err
}

// RemoveMember entfernt einen Nutzer — idempotent.
func (s *Store) RemoveMember(groupID, username string) error {
	_, err := s.db.Exec(`DELETE FROM group_members WHERE group_id = $1 AND username = $2`, groupID, username)
	return err
}

// GroupsForUser liefert alle Gruppen, in denen username Mitglied ist —
// z. B. für eine "meine effektiven Rechte"-Übersicht.
func (s *Store) GroupsForUser(username string) ([]Group, error) {
	rows, err := s.db.Query(`
		SELECT g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at
		FROM groups g
		JOIN group_members m ON m.group_id = g.id
		WHERE m.username = $1
		ORDER BY g.name
	`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// Package organizations implementiert Kapitel 21 B14 (Mandantenfähigkeit,
// Nachtrag 283) — Nutzerentscheidung 2026-09-23 (UMSETZUNG.md §21.6,
// Nachtrag 282): reine Zugriffs-Scope-Erweiterung (KEINE echte
// physische Daten-Isolation), eine Organisation pro Nutzer, globale
// Bindungen werden organisationsweit statt wörtlich global.
//
// Bewusst ein eigenständiges, kleines Paket statt Teil von
// internal/authz — Organisationen sind eine Entität für sich (mit
// eigenem CRUD/Lebenszyklus), authz.Binding selbst bleibt unverändert
// (s. Migrations-Kommentar: role_bindings bekommt bewusst KEINE eigene
// org_id-Spalte, bei 1 Org/Nutzer per Join über users.org_id ableitbar).
//
// Die "default"-Organisation (ID fest "default", s.
// db/migrations/0025_organizations.sql) ist die Organisation, in die
// jeder bereits vor Kapitel 21 B14 bestehende Nutzer/Fachobjekt
// automatisch gewandert ist — kein Bruch des heutigen Single-Tenant-
// Verhaltens. Sie kann wie jede andere Organisation gelistet/genutzt,
// aber NICHT gelöscht werden (s. DeleteOrganization).
package organizations

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// DefaultOrgID — s. Moduldoku und die Migration.
const DefaultOrgID = "default"

// ErrNotFound — gleiche Konvention wie process.ErrNotFound/
// asset.ErrNotFound.
var ErrNotFound = errors.New("organizations: not found")

// ErrValidation kennzeichnet fehlerhafte Aufrufer-Eingaben.
var ErrValidation = errors.New("organizations: validation failed")

// ErrDefaultOrgImmutable: die Default-Organisation kann nicht gelöscht
// werden — sie ist die Heimat aller Nutzer/Fachobjekte, die vor Kapitel
// 21 B14 angelegt wurden (und jedes neuen Nutzers ohne explizit
// gewählte Organisation), ihr Löschen hätte keine sinnvolle Bedeutung.
var ErrDefaultOrgImmutable = errors.New("organizations: the default organization cannot be deleted")

// Organization ist ein Mandant (B14).
type Organization struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// Store persistiert Organisationen in Postgres
// (db/migrations/0025_organizations.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene, bereits migrierte
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("organizations: id generation failed")
	}
	return id, nil
}

// Create legt eine neue Organisation an.
func (s *Store) Create(name string) (Organization, error) {
	if name == "" {
		return Organization{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return Organization{}, err
	}
	o := Organization{ID: id, Name: name, CreatedAt: time.Now().UTC()}
	_, err = s.db.Exec(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, o.ID, o.Name, o.CreatedAt)
	if err != nil {
		return Organization{}, err
	}
	return o, nil
}

func scanOrganization(row interface{ Scan(...any) error }) (Organization, error) {
	var o Organization
	err := row.Scan(&o.ID, &o.Name, &o.CreatedAt)
	return o, err
}

const selectColumns = `id, name, created_at`

// Get liefert eine einzelne Organisation.
func (s *Store) Get(id string) (Organization, error) {
	row := s.db.QueryRow(`SELECT `+selectColumns+` FROM organizations WHERE id = $1`, id)
	o, err := scanOrganization(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Organization{}, ErrNotFound
	}
	return o, err
}

// List liefert alle Organisationen, die Default-Organisation zuerst
// (stabile, vorhersagbare Reihenfolge für eine Verwaltungsansicht),
// danach alphabetisch.
func (s *Store) List() ([]Organization, error) {
	rows, err := s.db.Query(`SELECT ` + selectColumns + ` FROM organizations ORDER BY (id != '` + DefaultOrgID + `'), name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Organization{}
	for rows.Next() {
		o, err := scanOrganization(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Delete entfernt eine Organisation — lehnt die Default-Organisation
// ab (ErrDefaultOrgImmutable) und liefert einen echten Fremdschlüssel-
// Fehler, solange noch Nutzer/Fachobjekte auf sie verweisen (bewusst
// KEINE Kaskade: eine Organisation mit noch existierenden Mitgliedern/
// Fachobjekten stillschweigend zu löschen wäre genau die Art von
// "sieht fertig aus, verhält sich aber falsch"-Falle, vor der 21.5
// warnt — der Aufrufer muss diese erst explizit umziehen/löschen).
func (s *Store) Delete(id string) error {
	if id == DefaultOrgID {
		return ErrDefaultOrgImmutable
	}
	_, err := s.db.Exec(`DELETE FROM organizations WHERE id = $1`, id)
	return err
}

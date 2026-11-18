// Package mxldomains verwaltet benannte MXL-Domains neben der Standarddomain (Kap. 103, Entwurf
// docs/ENTWURF-MXL-DOMAIN-TRENNUNG.md, Schritte D1/D2).
//
// Eine Domain ist ein Verzeichnis im Arbeitsspeicher (tmpfs). Flows sind nur innerhalb einer Domain sichtbar; die
// Trennung ist eine Trennung nach Pfad, keine Kernel-Abschottung (gleiche UID, gleiches /dev/shm).
//
// Der Pfad wird NIE frei vom Aufrufer genommen, sondern aus dem validierten Namen abgeleitet:
// `<Standarddomain>-<name>` (Standard `/dev/shm/omp-mxl` → `/dev/shm/omp-mxl-<name>`). Damit kann über die API weder ein
// fremdes Verzeichnis als Domain eingetragen noch beim Löschen etwas anderes als ein solches Verzeichnis entfernt werden.
package mxldomains

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/podmanrun"
)

// DefaultName ist der Name der impliziten Standarddomain.
const DefaultName = "default"

var (
	ErrValidation = errors.New("mxldomains: validation failed")
	ErrExists     = errors.New("mxldomains: domain exists")
	ErrNotFound   = errors.New("mxldomains: domain not found")

	nameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$`)
)

// ValidateName prüft den Namen: Kleinbuchstaben, Ziffern, Bindestrich; beginnt mit Buchstabe, endet nicht mit
// Bindestrich; höchstens 32 Zeichen; "default" ist reserviert.
func ValidateName(name string) error {
	if name == DefaultName {
		return fmt.Errorf("%w: %q ist die Standarddomain", ErrValidation, name)
	}
	if !nameRe.MatchString(name) || strings.Contains(name, "--") {
		return fmt.Errorf("%w: %q (erlaubt: Kleinbuchstaben, Ziffern, Bindestrich; beginnt mit einem Buchstaben; höchstens 32 Zeichen)", ErrValidation, name)
	}
	return nil
}

// Domain ist eine Domain samt Pfad.
type Domain struct {
	Name string `json:"name"`
	// ID: die BCP-007-03-Domain-ID (UUIDv5 aus dem Namen, podmanrun.DomainID) — erscheint als mxl_domain_id in IS-05.
	ID          string `json:"id"`
	Path        string `json:"path"`
	Description string `json:"description,omitempty"`
	// Isolated: Nodes dieser Domain laufen in einer Mount-Sandbox, die nur ihre Domain sieht (D7, podmanrun.WrapSandbox).
	Isolated  bool      `json:"isolated,omitempty"`
	Default   bool      `json:"default,omitempty"`
	CreatedBy string    `json:"createdBy,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitzero"`
}

// Store hält die Domain-Liste in Postgres.
type Store struct {
	db          *sql.DB
	defaultPath string
}

// NewStore: defaultPath ist die Standarddomain (OMP_MXL_DOMAIN oder /dev/shm/omp-mxl).
func NewStore(db *sql.DB, defaultPath string) *Store {
	if defaultPath == "" {
		defaultPath = "/dev/shm/omp-mxl"
	}
	return &Store{db: db, defaultPath: strings.TrimRight(defaultPath, "/")}
}

// PathFor leitet den Pfad einer benannten Domain ab (ohne zu prüfen, ob sie existiert).
func (s *Store) PathFor(name string) string {
	if name == "" || name == DefaultName {
		return s.defaultPath
	}
	return s.defaultPath + "-" + name
}

// List liefert die Standarddomain und alle benannten Domains (nach Namen).
func (s *Store) List() ([]Domain, error) {
	out := []Domain{{Name: DefaultName, ID: podmanrun.DomainID(DefaultName), Path: s.defaultPath, Default: true}}
	rows, err := s.db.Query(`SELECT name, description, created_by, created_at, isolated FROM mxl_domains ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var named []Domain
	for rows.Next() {
		var d Domain
		if err := rows.Scan(&d.Name, &d.Description, &d.CreatedBy, &d.CreatedAt, &d.Isolated); err != nil {
			return nil, err
		}
		d.Path = s.PathFor(d.Name)
		d.ID = podmanrun.DomainID(d.Name)
		named = append(named, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(named, func(i, j int) bool { return named[i].Name < named[j].Name })
	return append(out, named...), nil
}

// Resolve liefert den Pfad einer bekannten Domain; leer/"default" = Standarddomain. Unbekannt → ErrNotFound.
func (s *Store) Resolve(name string) (string, error) {
	if name == "" || name == DefaultName {
		return s.defaultPath, nil
	}
	if err := ValidateName(name); err != nil {
		return "", err
	}
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM mxl_domains WHERE name=$1`, name).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("%w: %q", ErrNotFound, name)
	}
	if err != nil {
		return "", err
	}
	return s.PathFor(name), nil
}

// Isolated: ob die Domain abgeschottet ist (Standarddomain und Unbekanntes: nein).
func (s *Store) Isolated(name string) bool {
	if name == "" || name == DefaultName {
		return false
	}
	var iso bool
	if err := s.db.QueryRow(`SELECT isolated FROM mxl_domains WHERE name=$1`, name).Scan(&iso); err != nil {
		return false
	}
	return iso
}

// NameForPath ist die Umkehrung: Domainname zu einem Pfad (z. B. aus OMP_MXL_DOMAIN einer Instanz); unbekannte
// Pfade liefern den Pfad selbst, leer = Standarddomain.
func (s *Store) NameForPath(path string) string {
	path = strings.TrimRight(path, "/")
	if path == "" || path == s.defaultPath {
		return DefaultName
	}
	if rest, ok := strings.CutPrefix(path, s.defaultPath+"-"); ok && ValidateName(rest) == nil {
		return rest
	}
	return path
}

// Create legt eine Domain an (Eintrag + Verzeichnis 0755).
func (s *Store) Create(name, description, by string, isolated bool) (Domain, error) {
	if err := ValidateName(name); err != nil {
		return Domain{}, err
	}
	if len(description) > 200 {
		return Domain{}, fmt.Errorf("%w: Beschreibung höchstens 200 Zeichen", ErrValidation)
	}
	res, err := s.db.Exec(`INSERT INTO mxl_domains (name, description, created_by, isolated) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`, name, description, by, isolated)
	if err != nil {
		return Domain{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Domain{}, fmt.Errorf("%w: %q", ErrExists, name)
	}
	path := s.PathFor(name)
	if err := os.MkdirAll(path, 0o755); err != nil {
		_, _ = s.db.Exec(`DELETE FROM mxl_domains WHERE name=$1`, name)
		return Domain{}, fmt.Errorf("Verzeichnis %s anlegen: %w", path, err)
	}
	return Domain{Name: name, ID: podmanrun.DomainID(name), Path: path, Description: description, Isolated: isolated, CreatedBy: by, CreatedAt: time.Now()}, nil
}

// Delete entfernt den Eintrag. Das Verzeichnis wird nur entfernt, wenn es leer ist (os.Remove, kein RemoveAll): was
// noch Flows enthält, prüft und räumt der Aufrufer vorher ab. Die Standarddomain lässt sich nicht löschen.
func (s *Store) Delete(name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	res, err := s.db.Exec(`DELETE FROM mxl_domains WHERE name=$1`, name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: %q", ErrNotFound, name)
	}
	_ = os.Remove(s.PathFor(name))
	return nil
}

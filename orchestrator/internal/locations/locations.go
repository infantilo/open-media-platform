// Package locations verwaltet benannte lokale Speicherorte (Kapitel 29 Nachtrag B):
// Verzeichnisse/Shares, die ein Host lokal eingehängt hat (NFS/SMB/lokale Platte) und aus denen
// Medien-Nodes lesen. Anders als die S3/MinIO-Backends (internal/storagebackends) gibt es keinen
// Objektspeicher und keine Zugangsdaten — der Eintrag ist ein benannter Pfad je Host, dessen
// Erreichbarkeit und Platz der Orchestrator (bzw. der Host-Agent) prüft und der in den
// Node-Einstellungen als Auswahl angeboten wird. host_id leer = Orchestrator-Rechner.
package locations

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrNotFound   = errors.New("locations: nicht gefunden")
	ErrValidation = errors.New("locations: ungültig")
	ErrDuplicate  = errors.New("locations: Name oder Pfad (auf diesem Host) existiert bereits")
)

const (
	StatusActive     = "active"
	StatusDeprecated = "deprecated"
)

// Location ist ein Speicherort.
type Location struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	HostID    string    `json:"hostId"`
	Path      string    `json:"path"`
	Note      string    `json:"note,omitempty"`
	Status    string    `json:"status"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Input sind die schreibbaren Felder.
type Input struct {
	Name   string
	HostID string
	Path   string
	Note   string
}

// Validate prüft Name und Pfad (absolut, sauber, kein „..“).
func (in *Input) Validate() error {
	in.Name = strings.TrimSpace(in.Name)
	in.Path = strings.TrimSpace(in.Path)
	switch {
	case in.Name == "" || len(in.Name) > 64:
		return fmt.Errorf("%w: Name 1–64 Zeichen", ErrValidation)
	case strings.ContainsAny(in.Name, "\n\r\x00"):
		return fmt.Errorf("%w: Name enthält Steuerzeichen", ErrValidation)
	case in.Path == "" || !filepath.IsAbs(in.Path):
		return fmt.Errorf("%w: absoluter Pfad erforderlich (z. B. /mnt/medien)", ErrValidation)
	case strings.Contains(in.Path, "..") || strings.ContainsAny(in.Path, "\n\r\x00"):
		return fmt.Errorf("%w: ungültiger Pfad", ErrValidation)
	case len(in.Note) > 500:
		return fmt.Errorf("%w: Notiz zu lang", ErrValidation)
	}
	in.Path = filepath.Clean(in.Path)
	return nil
}

// Within meldet, ob value innerhalb des Speicherorts liegt (gleich oder darunter).
func Within(root, value string) bool {
	if root == "" || value == "" {
		return false
	}
	root, value = filepath.Clean(root), filepath.Clean(value)
	return value == root || strings.HasPrefix(value, strings.TrimSuffix(root, "/")+"/")
}

// Store persistiert Speicherorte (Tabelle storage_locations).
type Store struct{ db *sql.DB }

// NewStore erstellt den Speicher auf einer migrierten Datenbank.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

const cols = `id, name, host_id, path, note, status, created_by, created_at, updated_at`

func scan(r interface{ Scan(...any) error }) (Location, error) {
	var l Location
	err := r.Scan(&l.ID, &l.Name, &l.HostID, &l.Path, &l.Note, &l.Status, &l.CreatedBy, &l.CreatedAt, &l.UpdatedAt)
	return l, err
}

func isDuplicate(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "23505"))
}

// Create legt einen Speicherort an.
func (s *Store) Create(in Input, by string) (Location, error) {
	if err := in.Validate(); err != nil {
		return Location{}, err
	}
	id := tracing.NewID()
	if id == "" {
		return Location{}, errors.New("locations: id generation failed")
	}
	row := s.db.QueryRow(
		`INSERT INTO storage_locations (id, name, host_id, path, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING `+cols,
		id, in.Name, in.HostID, in.Path, in.Note, by)
	l, err := scan(row)
	if isDuplicate(err) {
		return Location{}, ErrDuplicate
	}
	return l, err
}

// Update ändert Name/Notiz/Status; Host und Pfad sind unveränderlich (andere Stelle = neuer Ort,
// sonst stünden bestehende Node-Einstellungen plötzlich auf einem anderen Verzeichnis).
func (s *Store) Update(id, name, note, status string) (Location, error) {
	cur, err := s.Get(id)
	if err != nil {
		return Location{}, err
	}
	in := Input{Name: name, Path: cur.Path, Note: note}
	if err := in.Validate(); err != nil {
		return Location{}, err
	}
	if status != StatusActive && status != StatusDeprecated {
		return Location{}, fmt.Errorf("%w: Status active oder deprecated", ErrValidation)
	}
	row := s.db.QueryRow(`UPDATE storage_locations SET name=$2, note=$3, status=$4, updated_at=now() WHERE id=$1 RETURNING `+cols, id, in.Name, in.Note, status)
	l, err := scan(row)
	if isDuplicate(err) {
		return Location{}, ErrDuplicate
	}
	return l, err
}

// Get liest einen Speicherort.
func (s *Store) Get(id string) (Location, error) {
	l, err := scan(s.db.QueryRow(`SELECT `+cols+` FROM storage_locations WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Location{}, ErrNotFound
	}
	return l, err
}

// List liefert alle Speicherorte nach Name.
func (s *Store) List() ([]Location, error) {
	rows, err := s.db.Query(`SELECT ` + cols + ` FROM storage_locations ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Location{}
	for rows.Next() {
		l, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Delete entfernt einen Speicherort (die Prüfung „noch in Gebrauch“ macht der Aufrufer).
func (s *Store) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM storage_locations WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

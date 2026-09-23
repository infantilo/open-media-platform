// Package assetlinks verknüpft eine ProcessExecution (internal/process)
// mit den AssetVersions (internal/asset), die sie gelesen/erzeugt hat
// (Kapitel 21 B10, Nachtrag 277). Eigenes, kleines Paket statt einer
// Erweiterung von internal/process ODER internal/asset — beide Domänen
// bleiben laut 21.2 strikt getrennt (kein Cross-Package-Import); dieses
// Paket referenziert beide Tabellen nur per Fremdschlüssel
// (db/migrations/0024_asset_links.sql), gleiches additive Muster wie
// internal/domainaudit (Nachtrag 274).
//
// Nutzerentscheidung 2026-09-23 (UMSETZUNG.md 21.5): generische
// Link-API statt automatischer Erkennung oder eines neuen Prozess-
// Schritt-Typs — jeder Aufrufer (typischerweise ein ServiceCall-/
// MediaFunction-/Script-Executor, aber auch von Hand über die HTTP-API)
// verlinkt explizit, mit einer Rolle ("input"/"output", frei, s.
// Migration).
package assetlinks

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// ErrValidation kennzeichnet fehlerhafte Aufrufer-Eingaben (fehlende
// Pflichtfelder) — gleiche Konvention wie process.ErrValidation/
// asset.ErrValidation, Grundlage für 400 statt 500 in der HTTP-API.
var ErrValidation = errors.New("assetlinks: validation failed")

// Link ist eine einzelne Verknüpfung zwischen einer ProcessExecution
// und einer AssetVersion.
type Link struct {
	ID                 string    `json:"id"`
	ProcessExecutionID string    `json:"processExecutionId"`
	AssetVersionID     string    `json:"assetVersionId"`
	Role               string    `json:"role"`
	CreatedAt          time.Time `json:"createdAt"`
}

// Store persistiert Links in Postgres (db/migrations/0024_asset_links.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("assetlinks: id generation failed")
	}
	return id, nil
}

// CreateLink verlinkt eine AssetVersion mit einer ProcessExecution.
// Idempotent bezüglich derselben (execution,version,role)-Kombination
// (UNIQUE-Constraint in der Migration, s. dortige Doku) — ein
// wiederholter Aufruf (z. B. ein per Retry erneut gelaufener Schritt,
// A4) liefert die bereits bestehende Zeile statt eines Konflikts.
func (s *Store) CreateLink(processExecutionID, assetVersionID, role string) (Link, error) {
	if processExecutionID == "" || assetVersionID == "" || role == "" {
		return Link{}, fmt.Errorf("%w: processExecutionId, assetVersionId and role are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return Link{}, err
	}
	l := Link{ID: id, ProcessExecutionID: processExecutionID, AssetVersionID: assetVersionID, Role: role, CreatedAt: time.Now().UTC()}
	_, err = s.db.Exec(`
		INSERT INTO process_execution_asset_links (id, process_execution_id, asset_version_id, role, created_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (process_execution_id, asset_version_id, role) DO NOTHING
	`, l.ID, l.ProcessExecutionID, l.AssetVersionID, l.Role, l.CreatedAt)
	if err != nil {
		return Link{}, err
	}
	row := s.db.QueryRow(`SELECT `+selectColumns+` FROM process_execution_asset_links WHERE process_execution_id = $1 AND asset_version_id = $2 AND role = $3`,
		processExecutionID, assetVersionID, role)
	return scanLink(row)
}

func scanLink(row interface{ Scan(...any) error }) (Link, error) {
	var l Link
	err := row.Scan(&l.ID, &l.ProcessExecutionID, &l.AssetVersionID, &l.Role, &l.CreatedAt)
	return l, err
}

const selectColumns = `id, process_execution_id, asset_version_id, role, created_at`

// ListByExecution liefert alle Links einer ProcessExecution — "welche
// AssetVersions hat dieser Lauf gelesen/erzeugt".
func (s *Store) ListByExecution(processExecutionID string) ([]Link, error) {
	return s.query(`process_execution_id = $1`, processExecutionID)
}

// ListByAssetVersion liefert alle Links einer AssetVersion — "welche
// Prozessläufe haben diese Version gelesen/erzeugt" (Rückverfolgung,
// z. B. für ein künftiges Asset-Historie-Panel).
func (s *Store) ListByAssetVersion(assetVersionID string) ([]Link, error) {
	return s.query(`asset_version_id = $1`, assetVersionID)
}

func (s *Store) query(where, arg string) ([]Link, error) {
	rows, err := s.db.Query(`SELECT `+selectColumns+` FROM process_execution_asset_links WHERE `+where+` ORDER BY created_at DESC`, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Link{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// DeleteLink entfernt einen Link — idempotent, kein Fehler, wenn er
// nicht (mehr) existiert.
func (s *Store) DeleteLink(id string) error {
	_, err := s.db.Exec(`DELETE FROM process_execution_asset_links WHERE id = $1`, id)
	return err
}

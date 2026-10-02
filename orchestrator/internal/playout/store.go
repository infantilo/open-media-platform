// Package playout ist die Orchestrator-Domäne der Playout-Automation
// (UMSETZUNG.md Kapitel 27, Entscheidungen E1/E2/E5 vom 2026-10-02):
// Channels als persistierte Objekte, ihr versionierter Automationszustand
// und das Journal ausgeführter Aktionen. Die Automator-Node
// (`omp-playout-automation`) hält keine Datenbank, sondern spricht diese
// Domäne über die HTTP-API (Service-Token) an.
//
// Bewusst NICHT hier: Playlist-Inhalte/Zeitplanlogik — der Snapshot ist für
// den Store opak (JSON), seine Struktur gehört dem Node.
package playout

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrNotFound   = errors.New("playout: not found")
	ErrValidation = errors.New("playout: validation failed")
	// ErrConflict: Optimistic Concurrency (Spec §168) — die übergebene
	// Version ist nicht die aktuelle, oder der Instanz-/Name-Eindeutigkeits-
	// bedingung wurde verletzt.
	ErrConflict = errors.New("playout: conflict")
)

// MaxStateBytes begrenzt einen Snapshot (ein Rundown mit Tausenden Events
// bleibt weit darunter; schützt vor versehentlichen Riesen-Schreibvorgängen).
const MaxStateBytes = 8 << 20

type Channel struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Timezone  string          `json:"timezone"`
	Group     string          `json:"group,omitempty"`
	Instance  string          `json:"instanceId,omitempty"`
	Config    json.RawMessage `json:"config"`
	CreatedBy string          `json:"createdBy"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// ChannelInput sind die änderbaren Felder (Create/Update).
type ChannelInput struct {
	Name     string          `json:"name"`
	Timezone string          `json:"timezone"`
	Group    string          `json:"group"`
	Instance string          `json:"instanceId"`
	Config   json.RawMessage `json:"config"`
}

// State ist der gespeicherte Automationszustand eines Channels.
type State struct {
	ChannelID string          `json:"channelId"`
	Version   int64           `json:"version"`
	State     json.RawMessage `json:"state"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func normalize(in ChannelInput) (ChannelInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return in, fmt.Errorf("%w: name required", ErrValidation)
	}
	if in.Timezone == "" {
		in.Timezone = "UTC"
	}
	// IANA-Name prüfen (Spec §172: keine selbst erfundene Zeitrechnung).
	if _, err := time.LoadLocation(in.Timezone); err != nil {
		return in, fmt.Errorf("%w: unknown timezone %q", ErrValidation, in.Timezone)
	}
	in.Group = strings.TrimSpace(in.Group)
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	} else if !json.Valid(in.Config) {
		return in, fmt.Errorf("%w: config is not valid JSON", ErrValidation)
	}
	return in, nil
}

const channelCols = `id, name, timezone, channel_group, instance_id, config, created_by, created_at, updated_at`

func scanChannel(row interface{ Scan(...any) error }) (Channel, error) {
	var c Channel
	var cfg []byte
	if err := row.Scan(&c.ID, &c.Name, &c.Timezone, &c.Group, &c.Instance, &cfg, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return Channel{}, err
	}
	c.Config = json.RawMessage(cfg)
	return c, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *Store) CreateChannel(in ChannelInput, createdBy string) (Channel, error) {
	in, err := normalize(in)
	if err != nil {
		return Channel{}, err
	}
	id := tracing.NewID()
	if id == "" {
		return Channel{}, fmt.Errorf("playout: id generation failed")
	}
	row := s.db.QueryRow(`INSERT INTO playout_channels (id, name, timezone, channel_group, instance_id, config, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING `+channelCols,
		id, in.Name, in.Timezone, in.Group, in.Instance, []byte(in.Config), createdBy)
	c, err := scanChannel(row)
	if isUniqueViolation(err) {
		return Channel{}, fmt.Errorf("%w: name or instance already in use", ErrConflict)
	}
	return c, err
}

func (s *Store) GetChannel(id string) (Channel, error) {
	c, err := scanChannel(s.db.QueryRow(`SELECT `+channelCols+` FROM playout_channels WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return c, err
}

// ChannelByInstance liefert den an die Instanz gebundenen Channel — so
// findet ein Automator seinen Channel (E2: eine Instanz pro Channel).
func (s *Store) ChannelByInstance(instanceID string) (Channel, error) {
	if instanceID == "" {
		return Channel{}, ErrNotFound
	}
	c, err := scanChannel(s.db.QueryRow(`SELECT `+channelCols+` FROM playout_channels WHERE instance_id=$1`, instanceID))
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return c, err
}

func (s *Store) ListChannels() ([]Channel, error) {
	rows, err := s.db.Query(`SELECT ` + channelCols + ` FROM playout_channels ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) UpdateChannel(id string, in ChannelInput) (Channel, error) {
	in, err := normalize(in)
	if err != nil {
		return Channel{}, err
	}
	row := s.db.QueryRow(`UPDATE playout_channels SET name=$2, timezone=$3, channel_group=$4, instance_id=$5, config=$6, updated_at=now()
		WHERE id=$1 RETURNING `+channelCols, id, in.Name, in.Timezone, in.Group, in.Instance, []byte(in.Config))
	c, err := scanChannel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	if isUniqueViolation(err) {
		return Channel{}, fmt.Errorf("%w: name or instance already in use", ErrConflict)
	}
	return c, err
}

func (s *Store) DeleteChannel(id string) error {
	res, err := s.db.Exec(`DELETE FROM playout_channels WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetState liefert den Snapshot; ErrNotFound, wenn der Channel existiert,
// aber noch nie ein Zustand geschrieben wurde (Version 0 für den ersten Put).
func (s *Store) GetState(channelID string) (State, error) {
	var st State
	var raw []byte
	err := s.db.QueryRow(`SELECT channel_id, version, state, updated_at FROM playout_state WHERE channel_id=$1`, channelID).
		Scan(&st.ChannelID, &st.Version, &raw, &st.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		if _, cerr := s.GetChannel(channelID); cerr != nil {
			return State{}, cerr
		}
		return State{}, ErrNotFound
	}
	st.State = json.RawMessage(raw)
	return st, err
}

// PutState schreibt den Snapshot, wenn expectedVersion der aktuellen
// Version entspricht (0 = noch kein Zustand vorhanden). Ergebnis: neue
// Version. Sonst ErrConflict — der Aufrufer liest neu und entscheidet.
func (s *Store) PutState(channelID string, expectedVersion int64, state json.RawMessage) (State, error) {
	if len(state) == 0 || !json.Valid(state) {
		return State{}, fmt.Errorf("%w: state is not valid JSON", ErrValidation)
	}
	if len(state) > MaxStateBytes {
		return State{}, fmt.Errorf("%w: state exceeds %d bytes", ErrValidation, MaxStateBytes)
	}
	if _, err := s.GetChannel(channelID); err != nil {
		return State{}, err
	}
	var row *sql.Row
	if expectedVersion == 0 {
		row = s.db.QueryRow(`INSERT INTO playout_state (channel_id, version, state) VALUES ($1, 1, $2)
			ON CONFLICT (channel_id) DO NOTHING RETURNING channel_id, version, state, updated_at`, channelID, []byte(state))
	} else {
		row = s.db.QueryRow(`UPDATE playout_state SET version=version+1, state=$3, updated_at=now()
			WHERE channel_id=$1 AND version=$2 RETURNING channel_id, version, state, updated_at`, channelID, expectedVersion, []byte(state))
	}
	var st State
	var raw []byte
	if err := row.Scan(&st.ChannelID, &st.Version, &raw, &st.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return State{}, ErrConflict
		}
		return State{}, err
	}
	st.State = json.RawMessage(raw)
	return st, nil
}

// RecordExecution trägt eine Aktion idempotent ins Journal ein und meldet,
// ob SIE die erste war (true) oder die ID schon vorhanden ist (false →
// nicht erneut ausführen; at-most-once, Spec §56/§116/§190). Der Node ruft
// das VOR der Aktion auf: ein Absturz dazwischen verliert die Aktion
// lieber, als sie nach dem Restart doppelt auszuführen.
func (s *Store) RecordExecution(channelID, executionID, kind string) (first bool, err error) {
	if strings.TrimSpace(executionID) == "" {
		return false, fmt.Errorf("%w: executionId required", ErrValidation)
	}
	if _, err := s.GetChannel(channelID); err != nil {
		return false, err
	}
	res, err := s.db.Exec(`INSERT INTO playout_executions (channel_id, execution_id, kind) VALUES ($1,$2,$3)
		ON CONFLICT (channel_id, execution_id) DO NOTHING`, channelID, executionID, kind)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// PruneExecutions löscht Journal-Einträge älter als olderThan (Housekeeping).
func (s *Store) PruneExecutions(olderThan time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM playout_executions WHERE executed_at < $1`, olderThan)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

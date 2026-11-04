package clusterupdate

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// PGStore speichert Rollouts in der Tabelle cluster_rollouts (Migration 0056).
type PGStore struct{ db *sql.DB }

// NewPGStore erzeugt den Postgres-Speicher.
func NewPGStore(db *sql.DB) *PGStore { return &PGStore{db: db} }

const rolloutCols = `id, kind, package_id, target_version, state, error, steps, created_by, created_at, updated_at`

func scanRollout(row interface{ Scan(...any) error }) (*Rollout, error) {
	var r Rollout
	var steps []byte
	if err := row.Scan(&r.ID, &r.Kind, &r.PackageID, &r.TargetVersion, &r.State, &r.Error, &steps, &r.CreatedBy, &r.Created, &r.Updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(steps, &r.Steps); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGStore) Active() (*Rollout, error) {
	return scanRollout(s.db.QueryRow(`SELECT ` + rolloutCols + ` FROM cluster_rollouts WHERE state IN ('running','failed') LIMIT 1`))
}

func (s *PGStore) Latest() (*Rollout, error) {
	return scanRollout(s.db.QueryRow(`SELECT ` + rolloutCols + ` FROM cluster_rollouts ORDER BY created_at DESC LIMIT 1`))
}

func (s *PGStore) Create(r *Rollout) error {
	steps, _ := json.Marshal(r.Steps)
	_, err := s.db.Exec(`INSERT INTO cluster_rollouts (id, kind, package_id, target_version, state, error, steps, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r.ID, r.Kind, r.PackageID, r.TargetVersion, r.State, r.Error, steps, r.CreatedBy, r.Created, r.Updated)
	if err != nil && strings.Contains(err.Error(), "cluster_rollouts_one_active") {
		return ErrActive
	}
	return err
}

func (s *PGStore) Save(r *Rollout) error {
	steps, _ := json.Marshal(r.Steps)
	_, err := s.db.Exec(`UPDATE cluster_rollouts SET state=$2, error=$3, steps=$4, updated_at=$5 WHERE id=$1`, r.ID, r.State, r.Error, steps, r.Updated)
	return err
}

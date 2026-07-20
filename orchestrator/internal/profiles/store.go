package profiles

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Store persistiert Snapshots in Postgres (db/migrations/
// 0008_node_type_profiles.sql) — ein Upsert pro Aggregationsintervall
// (§14.3c), kein Verlauf einzelner Snapshots.
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen eine bereits migrierte DB.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Upsert schreibt snap, überschreibt einen bestehenden Eintrag
// desselben (NodeType, HostID)-Paars vollständig (kein Merge über
// Aufrufe hinweg — der Collector übergibt bereits ein aus dem
// gesamten aktuellen Sample-Fenster berechnetes Snapshot).
func (s *Store) Upsert(ctx context.Context, snap Snapshot) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO node_type_profiles
			(node_type, host_id, cpu_min, cpu_avg, cpu_max, cpu_p95, rss_min, rss_avg, rss_max, sample_count, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (node_type, host_id) DO UPDATE SET
			cpu_min = $3, cpu_avg = $4, cpu_max = $5, cpu_p95 = $6,
			rss_min = $7, rss_avg = $8, rss_max = $9,
			sample_count = $10, updated_at = $11
	`, snap.NodeType, snap.HostID, snap.CPUMin, snap.CPUAvg, snap.CPUMax, snap.CPUP95,
		int64(snap.RSSMin), int64(snap.RSSAvg), int64(snap.RSSMax), snap.SampleCount, snap.UpdatedAt)
	if err != nil {
		return fmt.Errorf("profiles: upsert: %w", err)
	}
	return nil
}

// Get liest das Profil für (nodeType, hostID). ok=false, wenn (noch)
// keins existiert — der Aufrufer entscheidet, ob er dann den
// Typ-Fallback (GlobalHostID) nachfragt (s. httpapi.handleGetProfile).
func (s *Store) Get(ctx context.Context, nodeType, hostID string) (Snapshot, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT node_type, host_id, cpu_min, cpu_avg, cpu_max, cpu_p95, rss_min, rss_avg, rss_max, sample_count, updated_at
		FROM node_type_profiles WHERE node_type = $1 AND host_id = $2
	`, nodeType, hostID)

	var snap Snapshot
	var rssMin, rssAvg, rssMax int64
	err := row.Scan(&snap.NodeType, &snap.HostID, &snap.CPUMin, &snap.CPUAvg, &snap.CPUMax, &snap.CPUP95,
		&rssMin, &rssAvg, &rssMax, &snap.SampleCount, &snap.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, false, nil
	}
	if err != nil {
		return Snapshot{}, false, fmt.Errorf("profiles: get: %w", err)
	}
	snap.RSSMin, snap.RSSAvg, snap.RSSMax = uint64(rssMin), uint64(rssAvg), uint64(rssMax)
	return snap, true, nil
}

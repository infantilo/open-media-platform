// Package timeline: die Ereignis-Zeitleiste (UMSETZUNG.md Kap. 72.6) — „Was hat sich um 14:02 geändert?“.
// Betriebsereignisse werden aufgezeichnet (Recorder, Store); Bedienungen, Domänen-Audit und Fehler-Logs kommen beim Lesen
// aus ihren eigenen Tabellen dazu (Sources.Query).
package timeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"
)

// Severity einer Zeile.
const (
	SevInfo  = "info"
	SevWarn  = "warn"
	SevError = "error"
)

// Event ist eine gespeicherte Betriebszeile.
type Event struct {
	At       time.Time
	Kind     string
	Severity string
	Subject  string // Node-, Host-, Instanz- oder Workflow-ID, je nach Art
	Actor    string
	Data     map[string]any
}

// Store schreibt und liest die Tabelle timeline_events.
type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Insert speichert ein Ereignis; dedupKey (leer = keiner) lässt Doppelte still verschwinden.
func (s *Store) Insert(e Event) error {
	if e.At.IsZero() {
		e.At = time.Now()
	}
	if e.Severity == "" {
		e.Severity = SevInfo
	}
	data, err := json.Marshal(e.Data)
	if err != nil || e.Data == nil {
		data = []byte("{}")
	}
	var dedup any
	if k := dedupKey(e); k != "" {
		dedup = k
	}
	_, err = s.db.Exec(`INSERT INTO timeline_events (occurred_at, kind, severity, subject, actor, data, dedup_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedup_key) DO NOTHING`,
		e.At.UTC(), e.Kind, e.Severity, e.Subject, e.Actor, data, dedup)
	return err
}

// dedupKey: gleiche Art, gleicher Gegenstand, gleiche 5-Sekunden-Stufe = dasselbe Ereignis (mehrere Orchestratoren).
// Marker haben keinen Schlüssel (jeder Klick zählt).
func dedupKey(e Event) string {
	if e.Kind == "marker" {
		return ""
	}
	return e.Kind + "|" + e.Subject + "|" + time.Unix(e.At.Unix()/5*5, 0).UTC().Format(time.RFC3339)
}

// Row ist eine gelesene Zeile.
type Row struct {
	ID       int64
	At       time.Time
	Kind     string
	Severity string
	Subject  string
	Actor    string
	Data     json.RawMessage
}

// Query liefert die neuesten Zeilen im Fenster [since, until), neueste zuerst.
func (s *Store) Query(since, until time.Time, limit int) ([]Row, error) {
	rows, err := s.db.Query(`SELECT id, occurred_at, kind, severity, subject, actor, data FROM timeline_events
		WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at DESC, id DESC LIMIT $3`, since.UTC(), until.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var data []byte
		if err := rows.Scan(&r.ID, &r.At, &r.Kind, &r.Severity, &r.Subject, &r.Actor, &data); err != nil {
			return nil, err
		}
		r.Data = data
		out = append(out, r)
	}
	return out, rows.Err()
}

// PurgeOlderThan löscht Zeilen älter als retentionDays (<= 0: nichts).
func (s *Store) PurgeOlderThan(retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	res, err := s.db.Exec(`DELETE FROM timeline_events WHERE occurred_at < now() - ($1 * interval '1 day')`, retentionDays)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RunRetention löscht einmal sofort und danach täglich, bis ctx endet.
func (s *Store) RunRetention(ctx context.Context, retentionDays int) {
	run := func() {
		if n, err := s.PurgeOlderThan(retentionDays); err != nil {
			slog.Warn("timeline retention failed", "error", err)
		} else if n > 0 {
			slog.Info("timeline retention", "deleted", n)
		}
	}
	run()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

// Package audit protokolliert schreibende API-Zugriffe (ARCHITECTURE.md
// §12 Punkt 4: "Jede schreibende Aktion wird mit Nutzer-Identität
// protokolliert"), Postgres-Tabelle audit_log
// (db/migrations/0002_auth.sql) — Muster aus PIPELINE CONTROLLER
// übernommen (dortiges `_userLog`, s. docs/decisions.md D3 Teil 2).
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// RetentionInterval ist der Abstand zwischen zwei Durchläufen des
// Retention-Jobs (S5, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) —
// "täglicher Job" laut Review, ein Löschlauf pro Tag reicht bei einer
// Aufbewahrung von standardmäßig 90 Tagen bei weitem.
const RetentionInterval = 24 * time.Hour

// DefaultRetentionDays ist der Default für OMP_AUDIT_RETENTION_DAYS
// (config.go), falls nicht gesetzt.
const DefaultRetentionDays = 90

// Entry ist eine protokollierte Aktion.
type Entry struct {
	ID         int64     `json:"id"`
	OccurredAt time.Time `json:"occurredAt"`
	Username   string    `json:"username"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	NodeID     string    `json:"nodeId,omitempty"`
	Status     int       `json:"status"`
}

// EventPublisher verteilt ein "audit.appended"-Event an alle verbundenen
// Flow-Editor-/Admin-Tab-Clients (implementiert von *sse.Hub, S2 —
// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md). Optional, darf nil sein
// (z. B. in Tests) — gleiches Muster wie graph.EventPublisher.
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Store schreibt/liest Audit-Einträge.
type Store struct {
	db     *sql.DB
	events EventPublisher
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB, events EventPublisher) *Store {
	return &Store{db: db, events: events}
}

// Log schreibt einen Eintrag. Best-effort: ein DB-Fehler beim Loggen
// darf die eigentliche, bereits ausgeführte Aktion nicht rückwirkend
// scheitern lassen (der Request ist zum Zeitpunkt des Log-Aufrufs schon
// verarbeitet) — Fehler landen stattdessen im Log.
func (s *Store) Log(username, method, path, nodeID string, status int) {
	var nodeIDArg any
	if nodeID != "" {
		nodeIDArg = nodeID
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_log (username, method, path, node_id, status) VALUES ($1, $2, $3, $4, $5)`,
		username, method, path, nodeIDArg, status)
	if err != nil {
		slog.Warn("audit log write failed", "error", err, "username", username, "method", method, "path", path)
		return
	}
	// Reiner Trigger, keine Nutzdaten (gleiches Muster wie
	// graph.Service.publish): das Admin-Tab lädt bei Empfang einmal
	// GET /api/v1/admin/audit-log neu statt den Eintrag aus dem
	// Event-Payload zu rekonstruieren.
	if s.events != nil {
		s.events.Broadcast(sse.Event{Type: "audit.appended", Data: json.RawMessage("null")})
	}
}

// List liefert Einträge neueste zuerst, maximal limit, per Cursor
// (S5): before == 0 liefert die erste Seite, before > 0 liefert nur
// Einträge mit id < before — die ID (BIGSERIAL-PK, dicht/monoton,
// bereits indiziert) ist der Cursor, nicht der Zeitstempel, weil
// occurred_at bei schnell aufeinanderfolgenden Schreibzugriffen
// Duplikate haben kann, die ID nie. Der Aufrufer erkennt das Ende der
// Liste daran, dass weniger als limit Einträge zurückkommen (keine
// zusätzliche COUNT(*)-Abfrage nötig).
func (s *Store) List(before int64, limit int) ([]Entry, error) {
	rows, err := s.db.Query(
		`SELECT id, occurred_at, username, method, path, coalesce(node_id, ''), status
		 FROM audit_log WHERE $1 = 0 OR id < $1 ORDER BY id DESC LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.OccurredAt, &e.Username, &e.Method, &e.Path, &e.NodeID, &e.Status); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// PurgeOlderThan löscht Einträge, die älter als retentionDays sind,
// und liefert die Anzahl der gelöschten Zeilen. retentionDays <= 0
// deaktiviert die Löschung (kein Löschlauf statt eines möglicherweise
// überraschenden "alles löschen").
func (s *Store) PurgeOlderThan(retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	res, err := s.db.Exec(
		`DELETE FROM audit_log WHERE occurred_at < now() - ($1 * interval '1 day')`, retentionDays)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RunRetention führt PurgeOlderThan einmal sofort aus (Startup-Lauf,
// S5) und danach im RetentionInterval-Takt, bis ctx endet — gleiches
// Run(ctx)-Muster wie graph.Service.Run/registry.Poller.Run. Ein
// einzelner fehlgeschlagener Lauf wird geloggt, der nächste plangemäße
// Lauf versucht es erneut (gleiche Robustheits-Linie wie der Rest des
// Stacks, kein Retry-Backoff nötig bei einem täglichen Intervall).
func (s *Store) RunRetention(ctx context.Context, retentionDays int) {
	s.purgeOnce(retentionDays)

	ticker := time.NewTicker(RetentionInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.purgeOnce(retentionDays)
		}
	}
}

func (s *Store) purgeOnce(retentionDays int) {
	deleted, err := s.PurgeOlderThan(retentionDays)
	if err != nil {
		slog.Warn("audit retention purge failed", "error", err, "retention_days", retentionDays)
		return
	}
	if deleted > 0 {
		slog.Info("audit retention purge completed", "deleted", deleted, "retention_days", retentionDays)
	}
}

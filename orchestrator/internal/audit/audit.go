// Package audit protokolliert schreibende API-Zugriffe (ARCHITECTURE.md
// §12 Punkt 4: "Jede schreibende Aktion wird mit Nutzer-Identität
// protokolliert"), Postgres-Tabelle audit_log
// (db/migrations/0002_auth.sql) — Muster aus PIPELINE CONTROLLER
// übernommen (dortiges `_userLog`, s. docs/decisions.md D3 Teil 2).
package audit

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

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

// List liefert die jüngsten Einträge (neueste zuerst), maximal limit.
func (s *Store) List(limit int) ([]Entry, error) {
	rows, err := s.db.Query(
		`SELECT id, occurred_at, username, method, path, coalesce(node_id, ''), status
		 FROM audit_log ORDER BY occurred_at DESC LIMIT $1`, limit)
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

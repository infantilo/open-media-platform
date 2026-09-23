// Package domainaudit protokolliert fachliche Aktionen auf Domänen-
// Objekten (Kapitel 21, B13: "Asset X auf Status Y gesetzt", "Human-Task
// Z genehmigt") — additiv zu internal/audit, das nur HTTP-Request-
// Metadaten (Methode/Pfad/Status) protokolliert und dafür nicht erweitert
// wird (21.1: "'Asset created'/'Approval granted' passt nicht sauber in
// (Method,Path)"). Gleicher Store-/Log-/List-/Retention-Stil wie
// internal/audit (bewusst reuse des Musters, nicht des Codes — andere
// Tabelle, anderes Schema), Postgres-Tabelle domain_audit_log
// (db/migrations/0022_domain_audit.sql).
//
// Aktuell EIN Paket, von internal/process UND internal/asset genutzt
// (nicht je Domäne ein eigenes) — dieselbe Begründung wie die geteilte
// internal/statemachine-Hilfe (B8): echte Doppelnutzung rechtfertigt die
// Abstraktion, kein Premature-Abstraction-Verstoß.
package domainaudit

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// RetentionInterval/DefaultRetentionDays — s. internal/audit (gleicher
// Takt/Default, ein eigener OMP_DOMAIN_AUDIT_RETENTION_DAYS wäre reine
// Konfigurations-Verdopplung ohne fachlichen Unterschied).
const RetentionInterval = 24 * time.Hour

const DefaultRetentionDays = 90

// Entry ist eine protokollierte fachliche Aktion.
type Entry struct {
	ID         int64           `json:"id"`
	OccurredAt time.Time       `json:"occurredAt"`
	Actor      string          `json:"actor"`
	ObjectType string          `json:"objectType"`
	ObjectID   string          `json:"objectId"`
	Action     string          `json:"action"`
	Details    json.RawMessage `json:"details,omitempty"`
}

// EventPublisher — s. internal/audit.EventPublisher (identisches Muster,
// eigener Event-Typ "domainAudit.appended" statt "audit.appended", damit
// ein Admin-Tab beide unabhängig abonnieren kann).
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Store schreibt/liest Domain-Audit-Einträge.
type Store struct {
	db     *sql.DB
	events EventPublisher
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB, events EventPublisher) *Store {
	return &Store{db: db, events: events}
}

// Log schreibt einen Eintrag. Best-effort wie internal/audit.Store.Log:
// ein DB-Fehler beim Protokollieren darf die bereits ausgeführte
// fachliche Aktion nicht rückwirkend scheitern lassen. details darf nil
// sein (wird dann als leeres Objekt gespeichert, nie NULL — vereinfacht
// das Lesen, kein Sonderfall für "keine Details").
func (s *Store) Log(actor, objectType, objectID, action string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	raw, err := json.Marshal(details)
	if err != nil {
		slog.Warn("domain audit: marshal details failed", "error", err, "object_type", objectType, "object_id", objectID, "action", action)
		raw = []byte("{}")
	}
	_, err = s.db.Exec(
		`INSERT INTO domain_audit_log (actor, object_type, object_id, action, details) VALUES ($1, $2, $3, $4, $5)`,
		actor, objectType, objectID, action, raw)
	if err != nil {
		slog.Warn("domain audit log write failed", "error", err, "actor", actor, "object_type", objectType, "object_id", objectID, "action", action)
		return
	}
	// Reiner Trigger, keine Nutzdaten — s. internal/audit.Store.Log.
	if s.events != nil {
		s.events.Broadcast(sse.Event{Type: "domainAudit.appended", Data: json.RawMessage("null")})
	}
}

// List liefert Einträge neueste zuerst, maximal limit, per Cursor
// (identisches Muster zu internal/audit.Store.List, s. dortige Doku für
// die Cursor-statt-Zeitstempel-Begründung).
func (s *Store) List(before int64, limit int) ([]Entry, error) {
	rows, err := s.db.Query(
		`SELECT id, occurred_at, actor, object_type, object_id, action, details
		 FROM domain_audit_log WHERE $1 = 0 OR id < $1 ORDER BY id DESC LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEntries(rows)
}

// ListByObject liefert die Historie eines einzelnen Objekts, neueste
// zuerst, maximal limit — für ein "Historie"-Panel an Asset/Prozess-
// Detailansichten (nutzt domain_audit_log_object_idx).
func (s *Store) ListByObject(objectType, objectID string, limit int) ([]Entry, error) {
	rows, err := s.db.Query(
		`SELECT id, occurred_at, actor, object_type, object_id, action, details
		 FROM domain_audit_log WHERE object_type = $1 AND object_id = $2 ORDER BY id DESC LIMIT $3`,
		objectType, objectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEntries(rows)
}

func scanEntries(rows *sql.Rows) ([]Entry, error) {
	entries := []Entry{}
	for rows.Next() {
		var e Entry
		var details []byte
		if err := rows.Scan(&e.ID, &e.OccurredAt, &e.Actor, &e.ObjectType, &e.ObjectID, &e.Action, &details); err != nil {
			return nil, err
		}
		e.Details = json.RawMessage(details)
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// PurgeOlderThan/RunRetention — identisches Muster zu internal/audit
// (s. dortige Doku), eigene Tabelle.
func (s *Store) PurgeOlderThan(retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	res, err := s.db.Exec(
		`DELETE FROM domain_audit_log WHERE occurred_at < now() - ($1 * interval '1 day')`, retentionDays)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

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
		slog.Warn("domain audit retention purge failed", "error", err, "retention_days", retentionDays)
		return
	}
	if deleted > 0 {
		slog.Info("domain audit retention purge completed", "deleted", deleted, "retention_days", retentionDays)
	}
}

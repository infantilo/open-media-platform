package logbus

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// EventPublisher verteilt ein "log.appended"-Event an alle verbundenen
// Diagnose-Cockpit-Clients (ARCHITECTURE.md §25.3) — gleiches Muster wie
// audit.EventPublisher/graph.EventPublisher. Optional (darf nil sein).
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Store schreibt/liest die Postgres-Projektion des Log-Streams.
type Store struct {
	db     *sql.DB
	events EventPublisher
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB, events EventPublisher) *Store {
	return &Store{db: db, events: events}
}

// Insert schreibt einen einzelnen, bereits vom JetStream-Konsumenten
// gelesenen Eintrag. Ein fehlendes OccurredAt (z. B. ein Aufrufer, der
// Insert direkt statt über Publisher.Publish nutzt, das es immer
// setzt) fällt auf "jetzt" zurück statt eine Zeitzeile mit dem
// Go-Zeitnullwert (Jahr 1) zu schreiben — genau der Unterschied
// zwischen "übersehen" und "sofort als uralt einsortiert und beim
// nächsten Retention-Lauf ungewollt mitgelöscht".
func (s *Store) Insert(e Entry) error {
	if e.OccurredAt.IsZero() {
		e.OccurredAt = time.Now().UTC()
	}
	_, err := s.db.Exec(
		`INSERT INTO logs (occurred_at, level, message, trace_id, span_id, node_id, host_id, source)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		e.OccurredAt, e.Level, e.Message,
		nullIfEmpty(e.TraceID), nullIfEmpty(e.SpanID), nullIfEmpty(e.NodeID), nullIfEmpty(e.HostID),
		e.Source)
	if err != nil {
		return err
	}
	if s.events != nil {
		s.events.Broadcast(sse.Event{Type: "log.appended", Data: json.RawMessage("null")})
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Filter grenzt Query auf einen Ausschnitt ein — alle Felder sind
// optional (leerer Wert = keine Einschränkung auf dieses Feld).
// Before/Limit funktionieren wie audit.Store.List (ID-Cursor, neueste
// zuerst).
type Filter struct {
	TraceID string
	NodeID  string
	HostID  string
	Level   string
	Before  int64
	Limit   int
	// Levels: mehrere Stufen (ODER); ersetzt Level, wenn gesetzt.
	Levels []string
	// Query: Teilstring in der Meldung (ohne Groß-/Kleinschreibung).
	Query string
	// Since/Until: Zeitfenster [Since, Until).
	Since, Until time.Time
	// MsgKey: nur Meldungen, deren normalisierte Form (s. msgKeyExpr) so lautet.
	MsgKey string
}

// msgKeyExpr normalisiert eine Meldung, damit gleichartige zusammenfallen:
// UUIDs, Hex-IDs und Zahlen werden zu "#". ("node proxy call failed (GET
// /params/x): dial tcp 127.0.0.1:41199 …" ist dann dieselbe Meldung für
// jeden Node und jeden Port.)
const msgKeyExpr = `regexp_replace(left(message, 300), '[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}|[0-9a-fA-F]{12,}|[0-9]+', '#', 'g')`

func (f Filter) where() (string, []any) {
	clauses := []string{"($1 = 0 OR id < $1)"}
	args := []any{f.Before}
	add := func(format string, v any) {
		args = append(args, v)
		clauses = append(clauses, fmt.Sprintf(format, len(args)))
	}
	eq := func(column, value string) {
		if value != "" {
			add(column+" = $%d", value)
		}
	}
	eq("trace_id", f.TraceID)
	eq("node_id", f.NodeID)
	eq("host_id", f.HostID)
	if len(f.Levels) > 0 {
		add("level = ANY(string_to_array($%d, ','))", strings.Join(f.Levels, ","))
	} else {
		eq("level", f.Level)
	}
	if f.Query != "" {
		r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
		add("message ILIKE $%d", "%"+r.Replace(f.Query)+"%")
	}
	if !f.Since.IsZero() {
		add("occurred_at >= $%d", f.Since)
	}
	if !f.Until.IsZero() {
		add("occurred_at < $%d", f.Until)
	}
	if f.MsgKey != "" {
		add(msgKeyExpr+" = $%d", f.MsgKey)
	}
	return strings.Join(clauses, " AND "), args
}

// Group fasst gleichartige Meldungen zusammen (Summary).
type Group struct {
	Key     string    `json:"key"`
	Level   string    `json:"level"` // schwerste Stufe der Gruppe
	Count   int64     `json:"count"`
	First   time.Time `json:"first"`
	Last    time.Time `json:"last"`
	Example string    `json:"example"` // jüngste Meldung im Wortlaut
	NodeIDs []string  `json:"nodeIds"` // betroffene Nodes (höchstens 20)
}

// Summary liefert gleichartige Meldungen gruppiert, zuletzt aufgetretene zuerst.
func (s *Store) Summary(f Filter, limit int) ([]Group, error) {
	if limit <= 0 {
		limit = 50
	}
	f.Before = 0
	where, args := f.where()
	args = append(args, limit)
	q := fmt.Sprintf(`
		SELECT `+msgKeyExpr+` AS k,
		       CASE WHEN bool_or(level = 'error') THEN 'error' WHEN bool_or(level = 'warn') THEN 'warn' ELSE max(level) END,
		       count(*), min(occurred_at), max(occurred_at),
		       (array_agg(message ORDER BY id DESC))[1],
		       coalesce((array_agg(DISTINCT node_id) FILTER (WHERE node_id IS NOT NULL AND node_id <> ''))[1:20], '{}')
		FROM logs WHERE %s GROUP BY k ORDER BY max(occurred_at) DESC LIMIT $%d`, where, len(args))
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Group{}
	for rows.Next() {
		var g Group
		var nodes []byte
		if err := rows.Scan(&g.Key, &g.Level, &g.Count, &g.First, &g.Last, &g.Example, &nodes); err != nil {
			return nil, err
		}
		g.NodeIDs = parsePgTextArray(string(nodes))
		out = append(out, g)
	}
	return out, rows.Err()
}

// parsePgTextArray liest ein einfaches Postgres-Text-Array ({a,b,"c d"}).
func parsePgTextArray(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.TrimSuffix(s, "}"), "{")
	if s == "" {
		return []string{}
	}
	var out []string
	for _, p := range strings.Split(s, ",") {
		out = append(out, strings.Trim(p, `"`))
	}
	return out
}

// Query liefert Einträge neueste zuerst, gefiltert nach den gesetzten
// Filter-Feldern — genau die Abfrage hinter GET /api/v1/logs
// (ARCHITECTURE.md §25.2/§25.3: Trace-Waterfall braucht "alles mit
// dieser trace_id", der Live-Tail braucht "alles ab Cursor X").
func (s *Store) Query(f Filter) ([]Entry, error) {
	if f.Limit <= 0 {
		f.Limit = 200
	}
	where, args := f.where()
	args = append(args, f.Limit)

	query := fmt.Sprintf(
		`SELECT id, occurred_at, level, message, coalesce(trace_id, ''), coalesce(span_id, ''),
		        coalesce(node_id, ''), coalesce(host_id, ''), source
		 FROM logs WHERE %s ORDER BY id DESC LIMIT $%d`,
		where, len(args))

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.OccurredAt, &e.Level, &e.Message, &e.TraceID, &e.SpanID, &e.NodeID, &e.HostID, &e.Source); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// PurgeOlderThan löscht Einträge, die älter als retentionHours sind,
// und liefert die Anzahl der gelöschten Zeilen. retentionHours <= 0
// deaktiviert die Löschung — gleiche Sicherheitslinie wie
// audit.Store.PurgeOlderThan.
func (s *Store) PurgeOlderThan(retentionHours int) (int64, error) {
	if retentionHours <= 0 {
		return 0, nil
	}
	res, err := s.db.Exec(
		`DELETE FROM logs WHERE occurred_at < now() - ($1 * interval '1 hour')`, retentionHours)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RunRetention — gleiches Run(ctx)-Muster wie audit.Store.RunRetention:
// ein Startup-Lauf, danach im RetentionInterval-Takt, bis ctx endet.
func (s *Store) RunRetention(ctx context.Context, retentionHours int) {
	s.purgeOnce(retentionHours)

	ticker := time.NewTicker(RetentionInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.purgeOnce(retentionHours)
		}
	}
}

func (s *Store) purgeOnce(retentionHours int) {
	deleted, err := s.PurgeOlderThan(retentionHours)
	if err != nil {
		slog.Warn("logbus retention purge failed", "error", err, "retention_hours", retentionHours)
		return
	}
	if deleted > 0 {
		slog.Info("logbus retention purge completed", "deleted", deleted, "retention_hours", retentionHours)
	}
}

// Package asrun führt das As-Run-Protokoll der Playout-Automation (Kapitel 27 / P10,
// Spec §117–119, §192): was wann tatsächlich gesendet wurde (Primary Events, Child Events),
// welche manuellen Eingriffe es gab und welche Warnungen aufgetreten sind — plus die daraus
// abgeleiteten Kennzahlen (Start-Verspätung, Dauer, Fehlerzähler) für /metrics.
//
// Die Zeilen sind idempotent: der Automator-Node liefert mindestens einmal; ein Primary Event
// wird beim Start als RUNNING geschrieben und beim Ende mit demselben Schlüssel überschrieben.
package asrun

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Arten von Protokollzeilen.
const (
	KindPrimary  = "primary"
	KindChild    = "child"
	KindOperator = "operator"
	KindTrigger  = "trigger"
	KindWarning  = "warning"
)

// Primary-Status. RUNNING ist der einzige nicht-endgültige.
const (
	StatusRunning     = "RUNNING"
	StatusCompleted   = "COMPLETED"
	StatusInterrupted = "INTERRUPTED"
	StatusStopped     = "STOPPED"
	StatusSkipped     = "SKIPPED"
	StatusFailed      = "FAILED"
)

// ErrValidation: ungültige Eingabe (HTTP 400).
var ErrValidation = errors.New("ungültiger As-Run-Eintrag")

// MaxBatch begrenzt eine Lieferung des Nodes.
const MaxBatch = 500

// Record ist eine Protokollzeile.
type Record struct {
	ID                int64           `json:"id,omitempty"`
	ChannelID         string          `json:"channelId"`
	Key               string          `json:"key"`
	Kind              string          `json:"kind"`
	RecordedAt        time.Time       `json:"recordedAt"`
	EventID           string          `json:"eventId,omitempty"`
	ChildID           string          `json:"childId,omitempty"`
	Label             string          `json:"label,omitempty"`
	Asset             string          `json:"asset,omitempty"`
	Source            string          `json:"source,omitempty"`
	PlannedStart      *time.Time      `json:"plannedStart,omitempty"`
	ActualStart       *time.Time      `json:"actualStart,omitempty"`
	PlannedDurationMs *int64          `json:"plannedDurationMs,omitempty"`
	ActualEnd         *time.Time      `json:"actualEnd,omitempty"`
	Status            string          `json:"status,omitempty"`
	Reason            string          `json:"reason,omitempty"`
	Mode              string          `json:"mode,omitempty"`
	Operator          string          `json:"operator,omitempty"`
	Action            string          `json:"action,omitempty"`
	CorrelationID     string          `json:"correlationId,omitempty"`
	Detail            json.RawMessage `json:"detail,omitempty"`
}

// Filter für die Abfrage.
type Filter struct {
	ChannelID string
	Kind      string
	From, To  time.Time // auf recorded_at; Null = unbegrenzt
	Limit     int
}

// Store schreibt/liest das Protokoll.
type Store struct {
	db      *sql.DB
	Metrics *Metrics
}

// NewStore erstellt den Store; `metrics` darf nil sein.
func NewStore(db *sql.DB, metrics *Metrics) *Store { return &Store{db: db, Metrics: metrics} }

func validKind(k string) bool {
	switch k {
	case KindPrimary, KindChild, KindOperator, KindTrigger, KindWarning:
		return true
	}
	return false
}

func nullTime(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return t.UTC()
}

func nullInt(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

// Upsert schreibt eine Lieferung (idempotent über channel+key) und aktualisiert die Kennzahlen.
func (s *Store) Upsert(ctx context.Context, channelID string, recs []Record) error {
	if channelID == "" {
		return fmt.Errorf("%w: channelId fehlt", ErrValidation)
	}
	if len(recs) > MaxBatch {
		return fmt.Errorf("%w: höchstens %d Einträge je Lieferung", ErrValidation, MaxBatch)
	}
	for i := range recs {
		r := &recs[i]
		r.Key = strings.TrimSpace(r.Key)
		if r.Key == "" || !validKind(r.Kind) {
			return fmt.Errorf("%w: key fehlt oder kind unbekannt (%q)", ErrValidation, r.Kind)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, r := range recs {
		detail := []byte(r.Detail)
		if len(detail) == 0 {
			detail = []byte("{}")
		}
		at := r.RecordedAt
		if at.IsZero() {
			at = time.Now()
		}
		_, err := tx.ExecContext(ctx, `
INSERT INTO playout_asrun (channel_id, rec_key, kind, recorded_at, event_id, child_id, label, asset, source,
    planned_start, actual_start, planned_duration_ms, actual_end, status, reason, mode, operator, action, correlation_id, detail)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
ON CONFLICT (channel_id, rec_key) DO UPDATE SET
    recorded_at = EXCLUDED.recorded_at, label = EXCLUDED.label, asset = EXCLUDED.asset, source = EXCLUDED.source,
    planned_start = EXCLUDED.planned_start, actual_start = EXCLUDED.actual_start,
    planned_duration_ms = EXCLUDED.planned_duration_ms, actual_end = EXCLUDED.actual_end,
    status = EXCLUDED.status, reason = EXCLUDED.reason, mode = EXCLUDED.mode, operator = EXCLUDED.operator,
    action = EXCLUDED.action, correlation_id = EXCLUDED.correlation_id, detail = EXCLUDED.detail`,
			channelID, r.Key, r.Kind, at.UTC(), r.EventID, r.ChildID, r.Label, r.Asset, r.Source,
			nullTime(r.PlannedStart), nullTime(r.ActualStart), nullInt(r.PlannedDurationMs), nullTime(r.ActualEnd),
			r.Status, r.Reason, r.Mode, r.Operator, r.Action, r.CorrelationID, detail)
		if err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if s.Metrics != nil {
		for _, r := range recs {
			s.Metrics.Observe(channelID, r)
		}
	}
	return nil
}

// List liefert die Zeilen, neueste zuerst.
func (s *Store) List(ctx context.Context, f Filter) ([]Record, error) {
	if f.Limit <= 0 || f.Limit > 5000 {
		f.Limit = 500
	}
	q := `SELECT id, channel_id, rec_key, kind, recorded_at, event_id, child_id, label, asset, source,
    planned_start, actual_start, planned_duration_ms, actual_end, status, reason, mode, operator, action, correlation_id, detail
FROM playout_asrun WHERE 1=1`
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		q += fmt.Sprintf(" AND "+cond, len(args))
	}
	if f.ChannelID != "" {
		add("channel_id = $%d", f.ChannelID)
	}
	if f.Kind != "" {
		add("kind = $%d", f.Kind)
	}
	if !f.From.IsZero() {
		add("recorded_at >= $%d", f.From.UTC())
	}
	if !f.To.IsZero() {
		add("recorded_at <= $%d", f.To.UTC())
	}
	args = append(args, f.Limit)
	q += fmt.Sprintf(" ORDER BY recorded_at DESC, id DESC LIMIT $%d", len(args))
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var r Record
		var ps, as, ae sql.NullTime
		var pd sql.NullInt64
		var detail []byte
		if err := rows.Scan(&r.ID, &r.ChannelID, &r.Key, &r.Kind, &r.RecordedAt, &r.EventID, &r.ChildID, &r.Label, &r.Asset, &r.Source,
			&ps, &as, &pd, &ae, &r.Status, &r.Reason, &r.Mode, &r.Operator, &r.Action, &r.CorrelationID, &detail); err != nil {
			return nil, err
		}
		if ps.Valid {
			r.PlannedStart = &ps.Time
		}
		if as.Valid {
			r.ActualStart = &as.Time
		}
		if ae.Valid {
			r.ActualEnd = &ae.Time
		}
		if pd.Valid {
			v := pd.Int64
			r.PlannedDurationMs = &v
		}
		if string(detail) != "{}" && len(detail) > 0 {
			r.Detail = detail
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Prune löscht Zeilen älter als olderThan (Housekeeping).
func (s *Store) Prune(ctx context.Context, olderThan time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM playout_asrun WHERE recorded_at < $1`, olderThan.UTC())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// WriteCSV schreibt die Zeilen als CSV (Excel-freundlich: Semikolon wäre regional, hier Komma/RFC 4180).
func WriteCSV(w io.Writer, recs []Record) error {
	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"channel", "kind", "key", "recorded_at", "event_id", "child_id", "label", "asset", "source",
		"planned_start", "actual_start", "planned_duration_ms", "actual_end", "status", "reason", "mode", "operator", "action", "correlation_id"}); err != nil {
		return err
	}
	ts := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.UTC().Format(time.RFC3339Nano)
	}
	for _, r := range recs {
		pd := ""
		if r.PlannedDurationMs != nil {
			pd = strconv.FormatInt(*r.PlannedDurationMs, 10)
		}
		if err := cw.Write([]string{r.ChannelID, r.Kind, r.Key, r.RecordedAt.UTC().Format(time.RFC3339Nano), r.EventID, r.ChildID, r.Label, r.Asset, r.Source,
			ts(r.PlannedStart), ts(r.ActualStart), pd, ts(r.ActualEnd), r.Status, r.Reason, r.Mode, r.Operator, r.Action, r.CorrelationID}); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

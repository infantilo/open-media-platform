// Package channeltrigger vermittelt Trigger zwischen Playout-Channels (UMSETZUNG.md Kapitel 27 /
// P7; Spec §77–90, §163–165): der Orchestrator prüft die Berechtigung, protokolliert, stellt per
// NATS zu (mit bounded Wiederholung bis zur Quittung) und führt den Zustand je Zustellung. Der
// Ziel-Channel (omp-playout-automation) dedupliziert über die Trigger-ID und quittiert.
//
// Zustellgarantie: at-least-once (Wiederholung bis Quittung/Ablauf) + Deduplizierung am Ziel =
// wirksam genau einmal, solange das Ziel innerhalb der Frist erreichbar ist; danach „expired“
// (nie still verloren: der Zustand steht im Protokoll).
package channeltrigger

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrValidation = errors.New("channeltrigger: ungültig")
	ErrNotFound   = errors.New("channeltrigger: nicht gefunden")
)

// Events (Spec §81). Kanonisch mit Präfix CHANNEL_; die Kurzform („NEXT_LIVE“) wird akzeptiert.
const (
	EventNext     = "CHANNEL_NEXT"
	EventNextLive = "CHANNEL_NEXT_LIVE"
	EventJump     = "CHANNEL_JUMP"
	EventCut      = "CHANNEL_CUT"
	EventHold     = "CHANNEL_HOLD"
	EventResume   = "CHANNEL_RESUME"
	EventTrigger  = "CHANNEL_TRIGGER"
)

var events = map[string]bool{EventNext: true, EventNextLive: true, EventJump: true, EventCut: true, EventHold: true, EventResume: true, EventTrigger: true}

// NormalizeEvent akzeptiert „NEXT_LIVE“ wie „CHANNEL_NEXT_LIVE“.
func NormalizeEvent(e string) (string, error) {
	e = strings.ToUpper(strings.TrimSpace(e))
	if !strings.HasPrefix(e, "CHANNEL_") {
		e = "CHANNEL_" + e
	}
	if !events[e] {
		return "", fmt.Errorf("%w: unbekanntes Event %q", ErrValidation, e)
	}
	return e, nil
}

// Late-Policies (Spec §86).
const (
	LateExecuteImmediately = "EXECUTE_IMMEDIATELY"
	LateSkip               = "SKIP"
	LateResync             = "RESYNC"
	LateQueue              = "QUEUE"
)

// NormalizeLate: leer = EXECUTE_IMMEDIATELY.
func NormalizeLate(p string) (string, error) {
	p = strings.ToUpper(strings.TrimSpace(p))
	switch p {
	case "":
		return LateExecuteImmediately, nil
	case LateExecuteImmediately, LateSkip, LateResync, LateQueue:
		return p, nil
	}
	return "", fmt.Errorf("%w: unbekannte Late-Policy %q", ErrValidation, p)
}

// Status einer Zustellung.
const (
	StatusPublished   = "published"
	StatusScheduled   = "scheduled"
	StatusApplied     = "applied"
	StatusAppliedLate = "applied_late"
	StatusSkippedLate = "skipped_late"
	StatusFailed      = "failed"
	StatusRejected    = "rejected"
	StatusDenied      = "denied"
	StatusExpired     = "expired"
)

var ackStatuses = map[string]bool{StatusScheduled: true, StatusApplied: true, StatusAppliedLate: true, StatusSkippedLate: true, StatusFailed: true, StatusRejected: true}

// Target adressiert Ziel-Channels (Spec §82): genau eines von channel/group/all.
type Target struct {
	Channel string `json:"channel,omitempty"`
	Group   string `json:"group,omitempty"`
	// All: alle Channels, die der Ursprung steuern darf (Spec §82 „all linked channels“).
	All bool `json:"all,omitempty"`
}

// Validate prüft, dass genau ein Selektor gesetzt ist.
func (t Target) Validate() error {
	n := 0
	if t.Channel != "" {
		n++
	}
	if t.Group != "" {
		n++
	}
	if t.All {
		n++
	}
	if n != 1 {
		return fmt.Errorf("%w: target braucht genau eines von channel, group, all", ErrValidation)
	}
	return nil
}

// Request ist ein zu sendender Trigger.
type Request struct {
	Event  string          `json:"event"`
	Target Target          `json:"target"`
	Args   json.RawMessage `json:"args,omitempty"`
	// TargetTime: absoluter Zielzeitpunkt (Spec §85/§87); leer = sofort.
	TargetTime *time.Time `json:"targetTime,omitempty"`
	// RelativeOffsetMs: Versatz auf den Zielzeitpunkt (kann negativ sein), Spec §87.
	RelativeOffsetMs int64  `json:"relativeOffsetMs,omitempty"`
	LatePolicy       string `json:"latePolicy,omitempty"`
	// CorrelationID: gemeinsame Kennung einer Trigger-Kette (leer = neu erzeugt).
	CorrelationID string `json:"correlationId,omitempty"`
}

// Envelope ist die per NATS zugestellte Nachricht (Spec §84).
type Envelope struct {
	ID               string          `json:"id"`
	CorrelationID    string          `json:"correlationId"`
	OriginChannel    string          `json:"originChannel"`
	TargetChannel    string          `json:"targetChannel"`
	Event            string          `json:"event"`
	Args             json.RawMessage `json:"args,omitempty"`
	TargetTime       *time.Time      `json:"targetTime,omitempty"`
	RelativeOffsetMs int64           `json:"relativeOffsetMs,omitempty"`
	LatePolicy       string          `json:"latePolicy"`
	Seq              int64           `json:"seq"`
	// Timestamp: Sendezeitpunkt (UTC, ms).
	Timestamp time.Time `json:"timestamp"`
	Attempt   int       `json:"attempt"`
}

// Subject: NATS-Subject, auf dem ein Channel seine Trigger erhält.
func Subject(channelID string) string { return "omp.channel." + channelID + ".trigger" }

// Delivery ist das Ergebnis für EIN Ziel.
type Delivery struct {
	ID            string `json:"id"`
	TargetChannel string `json:"targetChannel"`
	TargetName    string `json:"targetName,omitempty"`
	Status        string `json:"status"`
	Detail        string `json:"detail,omitempty"`
	Seq           int64  `json:"seq,omitempty"`
}

// Record ist eine gespeicherte Zustellung (Protokoll / Trigger-Graph).
type Record struct {
	ID               string          `json:"id"`
	CorrelationID    string          `json:"correlationId"`
	OriginChannel    string          `json:"originChannel"`
	TargetChannel    string          `json:"targetChannel"`
	Event            string          `json:"event"`
	Args             json.RawMessage `json:"args,omitempty"`
	TargetTime       *time.Time      `json:"targetTime,omitempty"`
	RelativeOffsetMs int64           `json:"relativeOffsetMs,omitempty"`
	LatePolicy       string          `json:"latePolicy"`
	Seq              int64           `json:"seq"`
	CreatedBy        string          `json:"createdBy"`
	CreatedAt        time.Time       `json:"createdAt"`
	Status           string          `json:"status"`
	Detail           string          `json:"detail,omitempty"`
	StatusAt         time.Time       `json:"statusAt"`
	Attempts         int             `json:"attempts"`
}

// Rule erlaubt Ursprung → Ziel (Spec §164). Selektoren: "channel:<id>", "group:<name>", "*".
type Rule struct {
	ID        string    `json:"id"`
	Origin    string    `json:"origin"`
	Target    string    `json:"target"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

func validSelector(s string) bool {
	if s == "*" {
		return true
	}
	for _, p := range []string{"channel:", "group:"} {
		if strings.HasPrefix(s, p) && len(s) > len(p) && len(s) <= 100 {
			return true
		}
	}
	return false
}

func selects(selector string, ch playout.Channel) bool {
	switch {
	case selector == "*":
		return true
	case strings.HasPrefix(selector, "channel:"):
		return strings.TrimPrefix(selector, "channel:") == ch.ID
	case strings.HasPrefix(selector, "group:"):
		return ch.Group != "" && strings.TrimPrefix(selector, "group:") == ch.Group
	}
	return false
}

// Allowed prüft die Regeln: der Ursprung darf sich selbst immer steuern, andere nur per Regel.
func Allowed(rules []Rule, origin, target playout.Channel) bool {
	if origin.ID == target.ID {
		return true
	}
	for _, r := range rules {
		if selects(r.Origin, origin) && selects(r.Target, target) {
			return true
		}
	}
	return false
}

// Store speichert Regeln und Zustellungen.
type Store struct{ db *sql.DB }

// NewStore erstellt den Speicher auf einer migrierten Datenbank.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ---- Regeln ----

// Rules liefert alle Regeln.
func (s *Store) Rules() ([]Rule, error) {
	rows, err := s.db.Query(`SELECT id, origin, target, created_by, created_at FROM channel_trigger_rules ORDER BY origin, target`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var r Rule
		if err := rows.Scan(&r.ID, &r.Origin, &r.Target, &r.CreatedBy, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AddRule legt eine Regel an (idempotent über (origin,target)).
func (s *Store) AddRule(origin, target, by string) (Rule, error) {
	if !validSelector(origin) || !validSelector(target) {
		return Rule{}, fmt.Errorf("%w: Selektor erwartet channel:<id>, group:<name> oder *", ErrValidation)
	}
	id := tracing.NewID()
	var r Rule
	err := s.db.QueryRow(
		`INSERT INTO channel_trigger_rules (id, origin, target, created_by) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (origin, target) DO UPDATE SET origin = EXCLUDED.origin
		 RETURNING id, origin, target, created_by, created_at`, id, origin, target, by).
		Scan(&r.ID, &r.Origin, &r.Target, &r.CreatedBy, &r.CreatedAt)
	return r, err
}

// DeleteRule entfernt eine Regel.
func (s *Store) DeleteRule(id string) error {
	res, err := s.db.Exec(`DELETE FROM channel_trigger_rules WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Zustellungen ----

const recCols = `id, correlation_id, origin_channel, target_channel, event, args, target_time, relative_offset_ms, late_policy, seq, created_by, created_at, status, detail, status_at, attempts`

func scanRecord(r interface{ Scan(...any) error }) (Record, error) {
	var rec Record
	var args []byte
	var tt sql.NullTime
	err := r.Scan(&rec.ID, &rec.CorrelationID, &rec.OriginChannel, &rec.TargetChannel, &rec.Event, &args, &tt, &rec.RelativeOffsetMs,
		&rec.LatePolicy, &rec.Seq, &rec.CreatedBy, &rec.CreatedAt, &rec.Status, &rec.Detail, &rec.StatusAt, &rec.Attempts)
	if err != nil {
		return Record{}, err
	}
	rec.Args = args
	if tt.Valid {
		t := tt.Time
		rec.TargetTime = &t
	}
	return rec, nil
}

// insert legt eine Zustellung mit der nächsten Sequenznummer des Ziels an.
func (s *Store) insert(rec Record) (Record, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Record{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, "channel_triggers:"+rec.TargetChannel); err != nil {
		return Record{}, err
	}
	if err := tx.QueryRow(`SELECT COALESCE(MAX(seq), 0) + 1 FROM channel_triggers WHERE target_channel = $1`, rec.TargetChannel).Scan(&rec.Seq); err != nil {
		return Record{}, err
	}
	args := rec.Args
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	row := tx.QueryRow(
		`INSERT INTO channel_triggers (id, correlation_id, origin_channel, target_channel, event, args, target_time, relative_offset_ms, late_policy, seq, created_by, status, detail, attempts, last_attempt)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $14 > 0 THEN now() ELSE NULL END)
		 RETURNING `+recCols,
		rec.ID, rec.CorrelationID, rec.OriginChannel, rec.TargetChannel, rec.Event, []byte(args), rec.TargetTime, rec.RelativeOffsetMs,
		rec.LatePolicy, rec.Seq, rec.CreatedBy, rec.Status, rec.Detail, rec.Attempts)
	out, err := scanRecord(row)
	if err != nil {
		return Record{}, err
	}
	return out, tx.Commit()
}

// Ack aktualisiert den Zustand einer Zustellung; nur offene (published/scheduled) werden verändert.
// first=false: es lag schon ein Endzustand vor (z. B. doppelte Quittung).
func (s *Store) Ack(id, channel, status, detail string) (rec Record, first bool, err error) {
	if !ackStatuses[status] {
		return Record{}, false, fmt.Errorf("%w: Quittungsstatus %q", ErrValidation, status)
	}
	row := s.db.QueryRow(
		`UPDATE channel_triggers SET status = $3, detail = $4, status_at = now()
		 WHERE id = $1 AND target_channel = $2 AND status IN ('published','scheduled')
		 RETURNING `+recCols, id, channel, status, detail)
	rec, err = scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		cur, gerr := s.Get(id)
		if gerr != nil || cur.TargetChannel != channel {
			return Record{}, false, ErrNotFound
		}
		return cur, false, nil
	}
	return rec, err == nil, err
}

// Get liest eine Zustellung.
func (s *Store) Get(id string) (Record, error) {
	rec, err := scanRecord(s.db.QueryRow(`SELECT `+recCols+` FROM channel_triggers WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	return rec, err
}

// List liefert die jüngsten Zustellungen (optional nach Channel als Ursprung ODER Ziel).
func (s *Store) List(channel string, limit int) ([]Record, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + recCols + ` FROM channel_triggers`
	args := []any{}
	if channel != "" {
		q += ` WHERE origin_channel = $1 OR target_channel = $1`
		args = append(args, channel)
	}
	q += fmt.Sprintf(` ORDER BY created_at DESC, seq DESC LIMIT %d`, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// DueForRedelivery: noch offene Zustellungen, deren letzter Versuch länger als `every` zurückliegt.
func (s *Store) DueForRedelivery(every time.Duration, maxAttempts int) ([]Record, error) {
	rows, err := s.db.Query(
		`SELECT `+recCols+` FROM channel_triggers
		 WHERE status = 'published' AND attempts < $1 AND (last_attempt IS NULL OR last_attempt < now() - make_interval(secs => $2))
		 ORDER BY created_at LIMIT 200`, maxAttempts, every.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// MarkAttempt zählt einen Zustellversuch.
func (s *Store) MarkAttempt(id string) error {
	_, err := s.db.Exec(`UPDATE channel_triggers SET attempts = attempts + 1, last_attempt = now() WHERE id = $1`, id)
	return err
}

// ExpireOpen setzt offene Zustellungen, die älter als maxAge sind oder alle Versuche verbraucht haben
// (und seit mindestens `every` nicht mehr versucht wurden), auf expired. Liefert die betroffenen.
func (s *Store) ExpireOpen(maxAge, every time.Duration, maxAttempts int) ([]Record, error) {
	rows, err := s.db.Query(
		`UPDATE channel_triggers SET status = 'expired', detail = 'keine Quittung vom Ziel-Channel', status_at = now()
		 WHERE status = 'published' AND (created_at < now() - make_interval(secs => $1)
		       OR (attempts >= $3 AND last_attempt < now() - make_interval(secs => $2)))
		 RETURNING `+recCols, maxAge.Seconds(), every.Seconds(), maxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// SortByTime sortiert ein Ergebnis aufsteigend nach Erstellung (für die Graph-Darstellung).
func SortByTime(r []Record) {
	sort.SliceStable(r, func(i, j int) bool { return r[i].CreatedAt.Before(r[j].CreatedAt) })
}

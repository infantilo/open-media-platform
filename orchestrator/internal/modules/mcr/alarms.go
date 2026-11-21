package mcr

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// Alarmliste, Quittierung und Historie der Signalalarme (106.13d). Die Scope-Instanzen melden Eintritt und Ende über den Alarmbus
// (`omp.alert.<node>`); hier werden sie einem Event und einer Leitung zugeordnet, zusammengefasst und aufbewahrt.

// Alarm ist ein Eintrag der Historie.
type Alarm struct {
	ID        string     `json:"id"`
	EventID   string     `json:"eventId"`
	LineID    string     `json:"lineId"`
	LineName  string     `json:"lineName"`
	Kind      string     `json:"kind"`
	Severity  string     `json:"severity"`
	Text      string     `json:"text"`
	NodeID    string     `json:"nodeId,omitempty"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
	AckedBy   string     `json:"ackedBy,omitempty"`
	AckedAt   *time.Time `json:"ackedAt,omitempty"`
	// DurationSec: Dauer bis zum Ende bzw. bis jetzt.
	DurationSec float64 `json:"durationSec"`
}

const alarmCols = `id, event_id, line_id, line_name, kind, severity, text, node_id, started_at, ended_at, acked_by, acked_at`

func scanAlarm(r scanner) (Alarm, error) {
	var a Alarm
	var ended, acked sql.NullTime
	if err := r.Scan(&a.ID, &a.EventID, &a.LineID, &a.LineName, &a.Kind, &a.Severity, &a.Text, &a.NodeID, &a.StartedAt, &ended, &a.AckedBy, &acked); err != nil {
		return a, err
	}
	end := time.Now()
	if ended.Valid {
		t := ended.Time
		a.EndedAt, end = &t, t
	}
	if acked.Valid {
		t := acked.Time
		a.AckedAt = &t
	}
	a.DurationSec = end.Sub(a.StartedAt).Seconds()
	return a, nil
}

// Raise legt einen Alarm an; ein schon offener gleicher (Event, Leitung, Art) wird zusammengefasst (Text und Schweregrad aktualisiert).
func (s *Store) RaiseAlarm(ctx context.Context, a Alarm) (Alarm, bool, error) {
	row := s.db.QueryRowContext(ctx, `UPDATE mcr_alarms SET text=$4, severity=$5 WHERE id=(SELECT id FROM mcr_alarms WHERE event_id=$1 AND line_id=$2 AND kind=$3 AND ended_at IS NULL LIMIT 1) RETURNING `+alarmCols,
		a.EventID, a.LineID, a.Kind, a.Text, a.Severity)
	if out, err := scanAlarm(row); err == nil {
		return out, false, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return a, false, err
	}
	a.ID = newID()
	if a.StartedAt.IsZero() {
		a.StartedAt = time.Now()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcr_alarms (id, event_id, line_id, line_name, kind, severity, text, node_id, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		a.ID, a.EventID, a.LineID, a.LineName, a.Kind, a.Severity, a.Text, a.NodeID, a.StartedAt)
	return a, true, err
}

// ClearAlarm beendet den offenen Alarm; ohne offenen Alarm (Entwarnung ohne Eintritt) false — wird verworfen.
func (s *Store) ClearAlarm(ctx context.Context, eventID, lineID, kind string) (Alarm, bool, error) {
	row := s.db.QueryRowContext(ctx, `UPDATE mcr_alarms SET ended_at=now() WHERE event_id=$1 AND line_id=$2 AND kind=$3 AND ended_at IS NULL RETURNING `+alarmCols, eventID, lineID, kind)
	a, err := scanAlarm(row)
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, nil
	}
	return a, err == nil, err
}

// AckAlarm quittiert einen Alarm des Events (gemeinsamer Stand: jede Person sieht es).
func (s *Store) AckAlarm(ctx context.Context, eventID, alarmID, user string) (Alarm, error) {
	row := s.db.QueryRowContext(ctx, `UPDATE mcr_alarms SET acked_by=$3, acked_at=COALESCE(acked_at, now()) WHERE id=$2 AND event_id=$1 RETURNING `+alarmCols, eventID, alarmID, user)
	a, err := scanAlarm(row)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// EventAlarms: Alarme eines Events (neueste zuerst); `openOnly` = nur laufende.
func (s *Store) EventAlarms(ctx context.Context, eventID string, openOnly bool) ([]Alarm, error) {
	q := `SELECT ` + alarmCols + ` FROM mcr_alarms WHERE event_id=$1`
	if openOnly {
		q += ` AND ended_at IS NULL`
	}
	return s.queryAlarms(ctx, q+` ORDER BY started_at DESC LIMIT 500`, eventID)
}

// AlarmHistory: Historie über alle Events seit `since` (optional nach Event/Art gefiltert), neueste zuerst.
func (s *Store) AlarmHistory(ctx context.Context, since time.Time, eventID, kind string, limit int) ([]Alarm, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := `SELECT ` + alarmCols + ` FROM mcr_alarms WHERE started_at >= $1`
	args := []any{since}
	if eventID != "" {
		args = append(args, eventID)
		q += ` AND event_id=$2`
	}
	if kind != "" {
		args = append(args, kind)
		q += ` AND kind=$` + string(rune('0'+len(args)))
	}
	return s.queryAlarms(ctx, q+` ORDER BY started_at DESC LIMIT `+itoa(limit), args...)
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (s *Store) queryAlarms(ctx context.Context, q string, args ...any) ([]Alarm, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Alarm{}
	for rows.Next() {
		a, err := scanAlarm(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// OpenAlarmCounts: laufende Alarme je (Event, Leitung) für die Wand.
func (s *Store) OpenAlarms(ctx context.Context, eventIDs []string) (map[string][]Alarm, error) {
	out := map[string][]Alarm{}
	for _, id := range eventIDs {
		list, err := s.EventAlarms(ctx, id, true)
		if err != nil {
			return nil, err
		}
		out[id] = list
	}
	return out, nil
}

// PurgeAlarms löscht beendete Alarme, die älter als `before` sind; laufende bleiben.
func (s *Store) PurgeAlarms(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM mcr_alarms WHERE ended_at IS NOT NULL AND ended_at < $1`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CloseEventAlarms beendet alle offenen Alarme eines Events (Abbau, Rücknahme, Abbruch: ohne Event kein laufender Alarm).
func (s *Store) CloseEventAlarms(ctx context.Context, eventID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE mcr_alarms SET ended_at=now() WHERE event_id=$1 AND ended_at IS NULL`, eventID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---- Eingang vom Alarmbus ----

// AlarmIn ist ein Bus-Alarm einer Scope-/Normalizer-Instanz.
type AlarmIn struct {
	NodeID   string
	Kind     string
	State    string // raised | cleared
	Severity string
	Line     string
	Message  string
}

// ParseAlarmEvent liest ein SSE-Ereignis `omp.alert.<node>`; nur strukturierte Signalalarme (`signal-*`) kommen in die Historie.
func ParseAlarmEvent(ev sse.Event) (AlarmIn, bool) {
	const prefix = "omp.alert."
	if !strings.HasPrefix(ev.Type, prefix) {
		return AlarmIn{}, false
	}
	var p struct {
		NodeID   string `json:"node_id"`
		Message  string `json:"message"`
		Severity string `json:"severity"`
		Kind     string `json:"kind"`
		State    string `json:"state"`
		Line     string `json:"line"`
	}
	if json.Unmarshal(ev.Data, &p) != nil || !strings.HasPrefix(p.Kind, "signal-") {
		return AlarmIn{}, false
	}
	if p.NodeID == "" {
		p.NodeID = strings.TrimPrefix(ev.Type, prefix)
	}
	return AlarmIn{NodeID: p.NodeID, Kind: p.Kind, State: p.State, Severity: p.Severity, Line: p.Line, Message: p.Message}, true
}

// Subscriber liefert Bus-Ereignisse (im Orchestrator: der SSE-Hub).
type Subscriber interface {
	Subscribe() (<-chan sse.Event, func())
}

// WatchAlarms hört den Alarmbus ab, bis ctx endet. Nur auf dem Leader laufen lassen.
func (rt *Runtime) WatchAlarms(ctx context.Context, s *Service, hub Subscriber) {
	ch, cancel := hub.Subscribe()
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if in, ok := ParseAlarmEvent(ev); ok {
				c, cc := context.WithTimeout(ctx, 10*time.Second)
				if err := rt.IngestAlarm(c, s, in); err != nil {
					slog.Warn("mcr: Alarm verarbeiten", "kind", in.Kind, "error", err)
				}
				cc()
			}
		}
	}
}

// NodeResolver ordnet einen Node (IS-04-ID) seiner Workflow-Rolle zu (Workflow-ID, Rollenname).
type NodeResolver func(nodeID string) (workflowID, role string, ok bool)

// LocateAlarm bestimmt Event und Leitung zu einem Node: über die Überwachungs-Workflows (`mcr-mon:<Event>/<Leitung>`) oder die Rolle im
// Event-Workflow (Normalizer einer Leitung).
func (rt *Runtime) LocateAlarm(ctx context.Context, s *Service, nodeID string) (Event, Line, bool) {
	if rt.Resolve == nil {
		return Event{}, Line{}, false
	}
	wid, role, ok := rt.Resolve(nodeID)
	if !ok {
		return Event{}, Line{}, false
	}
	wf, err := rt.Wf.Get(wid)
	if err != nil {
		return Event{}, Line{}, false
	}
	d := wf.Definition.Description
	switch {
	case strings.HasPrefix(d, MonPrefix):
		evID, lineID, _ := strings.Cut(strings.TrimPrefix(d, MonPrefix), "/")
		e, err := s.St.GetEvent(ctx, evID)
		if err != nil {
			return Event{}, Line{}, false
		}
		for _, l := range e.Lines {
			if l.ID == lineID {
				return e, l, true
			}
		}
	case strings.HasPrefix(d, DescriptionPrefix):
		e, err := s.St.GetEvent(ctx, strings.TrimPrefix(d, DescriptionPrefix))
		if err != nil {
			return Event{}, Line{}, false
		}
		_, roles, err := rt.definitionFor(s, e)
		if err != nil {
			return Event{}, Line{}, false
		}
		for _, l := range e.Lines {
			lr := roles[l.ID]
			if role == lr.Normalizer || role == lr.Input || role == lr.OutVideo || role == lr.OutAudio {
				return e, l, true
			}
		}
	}
	return Event{}, Line{}, false
}

// IngestAlarm verarbeitet einen Bus-Alarm: zuordnen, Profil `off` beachten, Eintritt/Ende führen, Reaktionen auslösen.
func (rt *Runtime) IngestAlarm(ctx context.Context, s *Service, in AlarmIn) error {
	e, l, ok := rt.LocateAlarm(ctx, s, in.NodeID)
	if !ok {
		return nil // Alarm eines fremden Nodes (kein MCR-Event)
	}
	if EffectiveMon(e.Monitoring, l.Monitoring).Off() {
		return nil
	}
	name := l.Name
	switch in.State {
	case "cleared":
		a, changed, err := s.St.ClearAlarm(ctx, e.ID, l.ID, in.Kind)
		if err != nil || !changed {
			return err // Entwarnung ohne Eintritt wird verworfen
		}
		rt.onAlarm(ctx, s, e, a, false)
	default:
		sev := in.Severity
		if sev == "" {
			sev = "warning"
		}
		a, created, err := s.St.RaiseAlarm(ctx, Alarm{EventID: e.ID, LineID: l.ID, LineName: name, Kind: in.Kind, Severity: sev, Text: in.Message, NodeID: in.NodeID})
		if err != nil {
			return err
		}
		if created {
			rt.onAlarm(ctx, s, e, a, true)
		}
	}
	return nil
}

// ---- Routen ----

func (a *api) eventAlarms() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, ok := a.authorize(w, r, r.PathValue("id"), ActView)
		if !ok {
			return
		}
		out, err := a.svc.St.EventAlarms(r.Context(), e.ID, r.URL.Query().Get("open") == "1" || r.URL.Query().Get("open") == "true")
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"alarms": out})
	}
}

func (a *api) ackAlarm() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, ok := a.authorize(w, r, r.PathValue("id"), ActTest)
		if !ok {
			return
		}
		user := actorOf(r)
		if user == "" {
			user = "bedienung"
		}
		out, err := a.svc.St.AckAlarm(r.Context(), e.ID, r.PathValue("alarmId"), user)
		if err != nil {
			writeErr(w, err)
			return
		}
		a.svc.audit(user, e.ID, "alarm.ack", map[string]any{"alarm": out.ID, "kind": out.Kind})
		writeJSON(w, 200, out)
	}
}

func (a *api) alarmHistory() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days := 7
		if v := r.URL.Query().Get("days"); v != "" {
			if n, err := atoi(v); err == nil && n > 0 && n <= 365 {
				days = n
			}
		}
		out, err := a.svc.St.AlarmHistory(r.Context(), time.Now().AddDate(0, 0, -days), r.URL.Query().Get("event"), r.URL.Query().Get("kind"), 300)
		if err != nil {
			writeErr(w, err)
			return
		}
		if vis := a.visibleTo(r); vis != nil {
			cache := map[string]bool{}
			kept := out[:0]
			for _, al := range out {
				ok, seen := cache[al.EventID]
				if !seen {
					e, err := a.svc.St.GetEvent(r.Context(), al.EventID)
					ok = err == nil && vis(e) // gelöschte Events: nur mit Recht auf alles sichtbar
					cache[al.EventID] = ok
				}
				if ok {
					kept = append(kept, al)
				}
			}
			out = kept
		}
		writeJSON(w, 200, map[string]any{"alarms": out})
	}
}

func atoi(s string) (int, error) {
	var n int
	err := json.Unmarshal([]byte(s), &n)
	return n, err
}

// purgeAlarms räumt die Historie höchstens einmal pro Stunde auf (nur auf dem Leader, weil nur dort die Schleife läuft).
func (rt *Runtime) purgeAlarms(ctx context.Context, s *Service) {
	rt.mu.Lock()
	due := time.Since(rt.alarmPurged) > time.Hour
	if due {
		rt.alarmPurged = time.Now()
	}
	rt.mu.Unlock()
	if !due {
		return
	}
	n, err := s.St.PurgeAlarms(ctx, time.Now().AddDate(0, 0, -s.AlarmRetentionDays()))
	if err != nil {
		slog.Warn("mcr: Alarmhistorie aufräumen", "error", err)
	} else if n > 0 {
		slog.Info("mcr: Alarmhistorie aufgeräumt", "gelöscht", n)
	}
}

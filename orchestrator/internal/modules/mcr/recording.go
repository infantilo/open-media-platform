package mcr

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Aufzeichnung je Leitung (106.13b). `record.house` nimmt die Leitung im Hausformat (Ausgang der Kette) über den vorhandenen Ingest auf;
// der Auftrag läuft, solange das Event auf Sendung ist, und wird beim Abbau mit Teilaufnahme gesichert. Eine eigene Aufnahme-Infrastruktur
// gibt es nicht. Ein Mitschnitt des **Originalstroms** ist nicht möglich (ENTWURF-MCR.md §7: der Ingest nimmt nur MXL-Flows auf) und wird abgelehnt.

// RecordCfg ist `record` einer Leitung.
type RecordCfg struct {
	House     bool   `json:"house"`
	Original  bool   `json:"original,omitempty"`
	ProfileID string `json:"profileId,omitempty"`
	Dir       string `json:"dir,omitempty"` // Unterverzeichnis der Medienablage; leer = Standard des Ingest
}

// ParseRecord liest `record`; leer = keine Aufzeichnung.
func ParseRecord(raw json.RawMessage) (RecordCfg, error) {
	var c RecordCfg
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" || t == "{}" {
		return c, nil
	}
	err := json.Unmarshal(raw, &c)
	return c, err
}

// ValidateRecord prüft die Aufzeichnungsangaben einer Leitung.
func ValidateRecord(label string, raw json.RawMessage) error {
	c, err := ParseRecord(raw)
	if err != nil {
		return bad("%s: Aufzeichnung: %v", label, err)
	}
	if c.Original {
		return bad("%s: Ein Mitschnitt des Originalstroms ist nicht möglich — der Ingest nimmt nur das Bild im Hausformat (MXL) auf", label)
	}
	if c.House && strings.TrimSpace(c.ProfileID) == "" {
		return bad("%s: Aufzeichnung braucht ein Profil des Ingest", label)
	}
	if strings.ContainsAny(c.Dir, "\\") || strings.Contains(c.Dir, "..") || strings.HasPrefix(c.Dir, "/") {
		return bad("%s: Aufzeichnung: Verzeichnis darf kein Pfad nach außen sein", label)
	}
	return nil
}

// RecInput beschreibt einen Aufnahmeauftrag.
type RecInput struct {
	Name       string
	InstanceID string // Instanz am Ende der Kette (Quelle der Aufnahme)
	ProfileID  string
	Dir        string
	Start      time.Time
	DurationS  int64
	EventID    string
	LineID     string
	EventName  string
	LineName   string
}

// Recorder legt Aufnahmeaufträge an und beendet sie (im Orchestrator: das Ingest-Modul).
type Recorder interface {
	Start(ctx context.Context, in RecInput) (jobID string, err error)
	Stop(ctx context.Context, jobID string) error
}

// DefaultRecordS: Dauer, wenn das Event kein Ende hat (4 Stunden); der Abbau beendet früher.
const DefaultRecordS = 4 * 3600

// MaxRecordS: längste Einzelaufnahme (24 Stunden).
const MaxRecordS = 24 * 3600

// RecordDuration: Dauer ab `now` bis zum geplanten Ende des Events; ohne Ende oder in der Vergangenheit der Standard.
func RecordDuration(e Event, now time.Time) int64 {
	d := int64(DefaultRecordS)
	if e.PlannedEnd != nil && e.PlannedEnd.After(now) {
		d = int64(e.PlannedEnd.Sub(now).Seconds()) + 60 // eine Minute Nachlauf
	}
	if d > MaxRecordS {
		d = MaxRecordS
	}
	if d < 60 {
		d = 60
	}
	return d
}

// ---- Speicher ----

// RecordingStarted merkt den Auftrag einer Leitung.
func (s *Store) RecordingStarted(ctx context.Context, eventID, lineID, jobID string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcr_recordings (event_id, line_id, job_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, eventID, lineID, jobID)
	return err
}

// OpenRecordings: laufende Aufträge eines Events (Leitung → Auftrag).
func (s *Store) OpenRecordings(ctx context.Context, eventID string) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT line_id, job_id FROM mcr_recordings WHERE event_id=$1 AND stopped_at IS NULL`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var l, j string
		if err := rows.Scan(&l, &j); err != nil {
			return nil, err
		}
		out[l] = j
	}
	return out, rows.Err()
}

// RecordingStopped markiert den Auftrag als beendet.
func (s *Store) RecordingStopped(ctx context.Context, eventID, lineID, jobID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE mcr_recordings SET stopped_at=now() WHERE event_id=$1 AND line_id=$2 AND job_id=$3 AND stopped_at IS NULL`, eventID, lineID, jobID)
	return err
}

// ---- Ablauf ----

// reconcileRecordings startet für jede Leitung mit `record.house` im laufenden (live) Event genau einen Auftrag.
func (rt *Runtime) reconcileRecordings(ctx context.Context, s *Service, e Event, wf workflows.Workflow, roles map[string]LineRoles) {
	if rt.Recorder == nil || e.State != StateLive {
		return
	}
	open, err := s.St.OpenRecordings(ctx, e.ID)
	if err != nil {
		return
	}
	for _, l := range e.Lines {
		rc, _ := ParseRecord(l.Record)
		if !rc.House {
			continue
		}
		if _, running := open[l.ID]; running {
			continue
		}
		inst := instanceOf(wf, roles[l.ID].VideoOut())
		if inst == "" {
			continue // Leitung läuft noch nicht: nächster Abgleich
		}
		in := RecInput{Name: e.Name + " · " + l.Name, InstanceID: inst, ProfileID: rc.ProfileID, Dir: rc.Dir, Start: time.Now(), DurationS: RecordDuration(e, time.Now()),
			EventID: e.ID, LineID: l.ID, EventName: e.Name, LineName: l.Name}
		job, err := rt.Recorder.Start(ctx, in)
		if err != nil {
			rt.setRecError(e.ID, l.ID, err.Error())
			slog.Warn("mcr: Aufzeichnung starten", "event", e.ID, "line", l.Name, "error", err)
			continue
		}
		rt.setRecError(e.ID, l.ID, "")
		if err := s.St.RecordingStarted(ctx, e.ID, l.ID, job); err != nil {
			slog.Warn("mcr: Aufzeichnung merken", "event", e.ID, "error", err)
		}
	}
}

func (rt *Runtime) setRecError(eventID, lineID, msg string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.recErr == nil {
		rt.recErr = map[string]string{}
	}
	if msg == "" {
		delete(rt.recErr, eventID+"/"+lineID)
	} else {
		rt.recErr[eventID+"/"+lineID] = msg
	}
}

// StopRecordings beendet alle offenen Aufträge eines Events genau einmal (Abbau, Rücknahme, Abbruch).
func (rt *Runtime) StopRecordings(ctx context.Context, s *Service, eventID string) {
	if rt.Recorder == nil {
		return
	}
	open, err := s.St.OpenRecordings(ctx, eventID)
	if err != nil {
		return
	}
	for line, job := range open {
		if err := rt.Recorder.Stop(ctx, job); err != nil {
			slog.Warn("mcr: Aufzeichnung beenden", "event", eventID, "line", line, "job", job, "error", err)
			continue
		}
		_ = s.St.RecordingStopped(ctx, eventID, line, job)
	}
}

// RecordingStatus: Aufzeichnung je Leitung für die Statusabfrage.
func (rt *Runtime) RecordingStatus(ctx context.Context, s *Service, e Event) map[string]any {
	open, _ := s.St.OpenRecordings(ctx, e.ID)
	out := map[string]any{}
	for _, l := range e.Lines {
		rc, _ := ParseRecord(l.Record)
		if !rc.House {
			continue
		}
		m := map[string]any{"wanted": true}
		if j, ok := open[l.ID]; ok {
			m["jobId"], m["running"] = j, true
		}
		rt.mu.Lock()
		if msg := rt.recErr[e.ID+"/"+l.ID]; msg != "" {
			m["error"] = msg
		}
		rt.mu.Unlock()
		out[l.ID] = m
	}
	return out
}

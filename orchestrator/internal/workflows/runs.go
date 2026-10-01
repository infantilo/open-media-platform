package workflows

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// Lauf-Historie (Nutzerwunsch 2026-10-01): jeder tatsächliche Lauf eines
// Workflows wird mit echtem Start, echtem Ende und Anlass festgehalten, damit
// der Scheduler Plan und Wirklichkeit nebeneinander zeigen kann (z. B. ein
// vorzeitig von Hand gestoppter Lauf).

// Quellen/Gründe — start_source bzw. end_reason in workflow_runs.
const (
	RunSourceManual      = "manual"
	RunSourceSchedule    = "schedule"
	RunSourceAdopted     = "adopted"  // beim Anlegen mit bereits laufenden Instanzen übernommen
	RunSourceRestored    = "restored" // beim Orchestrator-Start als laufend vorgefunden
	RunEndManual         = "manual"
	RunEndScheduled      = "scheduled"
	RunEndFailed         = "failed"
	RunEndUnknown        = "unknown" // Ende nicht beobachtet (z. B. Orchestrator war aus)
	DefaultRunRetainDays = 30
)

// RunRecorder hält Läufe fest; nil im Service = keine Historie (Tests).
type RunRecorder interface {
	Open(workflowID, workflowName, source string, at time.Time) error
	Close(workflowID, reason string, at time.Time) error
	// OpenWorkflowIDs: Workflows mit einem noch offenen Lauf.
	OpenWorkflowIDs() (map[string]bool, error)
}

// Run ist ein Lauf wie die API ihn liefert.
type Run struct {
	ID           int64      `json:"id"`
	WorkflowID   string     `json:"workflowId"`
	WorkflowName string     `json:"workflowName"`
	StartedAt    time.Time  `json:"startedAt"`
	EndedAt      *time.Time `json:"endedAt,omitempty"` // nil = läuft noch
	StartSource  string     `json:"startSource"`
	EndReason    string     `json:"endReason,omitempty"`
}

type triggerKey struct{}

// WithTrigger markiert einen Start/Stop als vom Zeitplan ausgelöst (Standard
// ohne Markierung: von Hand).
func WithTrigger(ctx context.Context, source string) context.Context {
	return context.WithValue(ctx, triggerKey{}, source)
}

func triggerOf(ctx context.Context) string {
	if v, ok := ctx.Value(triggerKey{}).(string); ok && v != "" {
		return v
	}
	return RunSourceManual
}

// SetRunRecorder verdrahtet die Lauf-Historie (optional).
func (s *Service) SetRunRecorder(r RunRecorder) { s.runs = r }

func (s *Service) runOpen(wf Workflow, source string) {
	if s.runs == nil {
		return
	}
	if err := s.runs.Open(wf.ID, wf.Name, source, time.Now()); err != nil {
		slog.Warn("workflows: run history open failed", "workflow", wf.ID, "error", err)
	}
}

func (s *Service) runClose(workflowID, reason string) {
	if s.runs == nil {
		return
	}
	if err := s.runs.Close(workflowID, reason, time.Now()); err != nil {
		slog.Warn("workflows: run history close failed", "workflow", workflowID, "error", err)
	}
}

// ReconcileRuns gleicht die Historie beim Orchestrator-Start mit dem
// tatsächlichen Zustand ab: offene Läufe von Workflows, die nicht mehr
// laufen, werden als "unknown" beendet; laufende Workflows ohne offenen Lauf
// (gestartet, bevor es die Historie gab) bekommen einen ab ihrem letzten
// Statuswechsel.
func (s *Service) ReconcileRuns() {
	if s.runs == nil {
		return
	}
	open, err := s.runs.OpenWorkflowIDs()
	if err != nil {
		slog.Warn("workflows: run history reconcile failed", "error", err)
		return
	}
	list, err := s.store.List()
	if err != nil {
		return
	}
	known := map[string]bool{}
	for _, wf := range list {
		known[wf.ID] = true
		running := wf.Status == StatusStarted || wf.Status == StatusStarting
		switch {
		case running && !open[wf.ID]:
			if err := s.runs.Open(wf.ID, wf.Name, RunSourceRestored, wf.UpdatedAt); err != nil {
				slog.Warn("workflows: run history restore failed", "workflow", wf.ID, "error", err)
			}
		case !running && open[wf.ID]:
			s.runClose(wf.ID, RunEndUnknown)
		}
	}
	for id := range open {
		if !known[id] { // Workflow wurde gelöscht
			s.runClose(id, RunEndUnknown)
		}
	}
}

// RunStore persistiert Läufe in Postgres (workflow_runs, Migration 0031).
type RunStore struct{ db *sql.DB }

func NewRunStore(db *sql.DB) *RunStore { return &RunStore{db: db} }

// Open beendet einen evtl. noch offenen Lauf desselben Workflows (als
// "unknown") und legt den neuen an — pro Workflow höchstens ein offener.
func (r *RunStore) Open(workflowID, workflowName, source string, at time.Time) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("workflows: run open: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`UPDATE workflow_runs SET ended_at = $2, end_reason = $3 WHERE workflow_id = $1 AND ended_at IS NULL`,
		workflowID, at, RunEndUnknown); err != nil {
		return fmt.Errorf("workflows: run open (close stale): %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO workflow_runs (workflow_id, workflow_name, started_at, start_source) VALUES ($1, $2, $3, $4)`,
		workflowID, workflowName, at, source); err != nil {
		return fmt.Errorf("workflows: run open (insert): %w", err)
	}
	return tx.Commit()
}

func (r *RunStore) Close(workflowID, reason string, at time.Time) error {
	_, err := r.db.Exec(`UPDATE workflow_runs SET ended_at = $2, end_reason = $3 WHERE workflow_id = $1 AND ended_at IS NULL`,
		workflowID, at, reason)
	if err != nil {
		return fmt.Errorf("workflows: run close: %w", err)
	}
	return nil
}

func (r *RunStore) OpenWorkflowIDs() (map[string]bool, error) {
	rows, err := r.db.Query(`SELECT workflow_id FROM workflow_runs WHERE ended_at IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("workflows: run open ids: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// maxRunsPerQuery begrenzt eine Abfrage — bei 30 Tagen Aufbewahrung und
// einem Lauf pro Workflow und Tag bleibt das weit darunter.
const maxRunsPerQuery = 5000

// List liefert Läufe, die den Zeitraum [from, to) berühren (offene Läufe
// zählen bis "jetzt"), aufsteigend nach Start.
func (r *RunStore) List(from, to time.Time) ([]Run, error) {
	rows, err := r.db.Query(`
		SELECT id, workflow_id, workflow_name, started_at, ended_at, start_source, end_reason
		FROM workflow_runs
		WHERE started_at < $2 AND (ended_at IS NULL OR ended_at > $1)
		ORDER BY started_at LIMIT $3`, from, to, maxRunsPerQuery)
	if err != nil {
		return nil, fmt.Errorf("workflows: run list: %w", err)
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		var run Run
		var ended sql.NullTime
		if err := rows.Scan(&run.ID, &run.WorkflowID, &run.WorkflowName, &run.StartedAt, &ended, &run.StartSource, &run.EndReason); err != nil {
			return nil, err
		}
		if ended.Valid {
			t := ended.Time
			run.EndedAt = &t
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// TrackingSince: Zeitpunkt des ältesten gespeicherten Laufs (zero, wenn noch
// keiner existiert) — davor gibt es keine Aufzeichnung, der Scheduler fällt
// dort auf den Plan zurück.
func (r *RunStore) TrackingSince() (time.Time, error) {
	var t sql.NullTime
	if err := r.db.QueryRow(`SELECT min(started_at) FROM workflow_runs`).Scan(&t); err != nil {
		return time.Time{}, fmt.Errorf("workflows: run tracking since: %w", err)
	}
	return t.Time, nil
}

// PurgeOlderThan löscht beendete Läufe, die vor mehr als retentionDays Tagen
// endeten; retentionDays <= 0 deaktiviert das Löschen.
func (r *RunStore) PurgeOlderThan(retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	res, err := r.db.Exec(`DELETE FROM workflow_runs WHERE ended_at IS NOT NULL AND ended_at < now() - ($1 * interval '1 day')`, retentionDays)
	if err != nil {
		return 0, fmt.Errorf("workflows: run purge: %w", err)
	}
	return res.RowsAffected()
}

// RunRetention löscht einmal sofort und danach täglich, bis ctx endet
// (gleiches Muster wie audit.Store.RunRetention).
func (r *RunStore) RunRetention(ctx context.Context, retentionDays int) {
	purge := func() {
		n, err := r.PurgeOlderThan(retentionDays)
		if err != nil {
			slog.Warn("workflow run retention purge failed", "error", err, "retention_days", retentionDays)
			return
		}
		if n > 0 {
			slog.Info("workflow run retention purge completed", "deleted", n, "retention_days", retentionDays)
		}
	}
	purge()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			purge()
		}
	}
}

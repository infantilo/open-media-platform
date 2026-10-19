package review

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// errNoop: die Aktion hat nichts zu ändern (idempotent) — keine Revision, kein Verlauf.
var errNoop = errors.New("review: no-op")

var (
	ErrNotFound   = errors.New("review: nicht gefunden")
	ErrConflict   = errors.New("review: Revisionskonflikt — der Stand hat sich geändert")
	ErrState      = errors.New("review: Aktion im aktuellen Zustand nicht erlaubt")
	ErrForbidden  = errors.New("review: nicht berechtigt")
	ErrClaimed    = errors.New("review: bereits von jemand anderem übernommen")
	ErrValidation = errors.New("review: ungültige Eingabe")
)

// ValidationError trägt die Einzelmeldungen.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "review: ungültige Eingabe: " + strings.Join(e.Problems, "; ")
}
func (e *ValidationError) Is(t error) bool { return t == ErrValidation }

// Transitions: erlaubte Zustandswechsel des Review-Ablaufs (explizit, wie asset.LifecycleTransitions).
var Transitions = statemachine.New([][2]string{
	{StateAwaitingQC, StateQCRunning},
	{StateAwaitingQC, StateInReview}, // Review trotz fehlender QC (Richtlinie)
	{StateQCRunning, StateAwaitingReview},
	{StateQCRunning, StateQCFailedToRun},
	{StateQCRunning, StateAwaitingQC}, // verwaister Auftrag zurückgesetzt
	{StateQCRunning, StateInReview},
	{StateQCFailedToRun, StateAwaitingQC},
	{StateQCFailedToRun, StateInReview},
	{StateAwaitingReview, StateAwaitingQC}, // QC wiederholen
	{StateAwaitingReview, StateInReview},
	{StateAwaitingReview, StateArchived},
	{StateInReview, StateConforming},
	{StateInReview, StateAwaitingReview}, // freigegeben (Release)
	{StateInReview, StateReadyForApproval},
	{StateConforming, StateReadyForApproval},
	{StateConforming, StateAwaitingReview}, // Release (Entwurf bleibt erhalten)
	{StateConforming, StateInReview},
	{StateInReview, StateApproved},   // Einreichen ohne Freigabestufe (approvalMode none)
	{StateConforming, StateApproved}, // dito
	{StateReadyForApproval, StateApproved},
	{StateReadyForApproval, StateRejected},
	{StateReadyForApproval, StateInReview}, // zurückgezogen
	{StateRejected, StateInReview},
	{StateRejected, StateArchived},
	{StateApproved, StateInReview}, // neue Revision
	{StateApproved, StateArchived},
	{StateArchived, StateAwaitingReview},
})

// Store kapselt den Zugriff auf die Tabellen des Moduls.
type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func newID() string { return tracing.NewID() }

const itemCols = `i.asset_id, i.source_version_id, i.source_rep_id, i.file_name, COALESCE(a.title,''), i.source_rev, i.size_bytes, i.format,
 i.ingest_job, i.state, i.assignee, i.claimed_at, i.revision, i.qc_status, i.qc_fail_count, i.qc_warn_count, i.qc_report_id, i.timeline,
 i.approval_mode, COALESCE((SELECT MAX(revision) FROM conform_revisions c WHERE c.asset_id=i.asset_id AND c.state <> 'draft'),0), i.created_at, i.updated_at`

const itemFrom = ` FROM review_items i LEFT JOIN assets a ON a.id = i.asset_id`

func scanItem(r interface{ Scan(...any) error }) (Item, error) {
	var it Item
	var claimed sql.NullTime
	var tl []byte
	err := r.Scan(&it.AssetID, &it.SourceVersionID, &it.SourceRepID, &it.FileName, &it.Title, &it.SourceRev, &it.SizeBytes, &it.Format,
		&it.IngestJob, &it.State, &it.Assignee, &claimed, &it.Revision, &it.QCStatus, &it.QCFail, &it.QCWarn, &it.QCReportID, &tl,
		&it.ApprovalMode, &it.ConformRevision, &it.CreatedAt, &it.UpdatedAt)
	if err != nil {
		return it, err
	}
	if claimed.Valid {
		t := claimed.Time
		it.ClaimedAt = &t
	}
	if len(tl) > 0 && string(tl) != "null" {
		var t Timeline
		if json.Unmarshal(tl, &t) == nil {
			it.Timeline = &t
		}
	}
	return it, nil
}

// GetItem liest einen Eintrag der Arbeitsliste.
func (s *Store) GetItem(ctx context.Context, id string) (Item, error) {
	it, err := scanItem(s.db.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE i.asset_id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return it, ErrNotFound
	}
	return it, err
}

// ListFilter für die Arbeitsliste.
type ListFilter struct {
	States   []string
	Assignee string // "me:<name>" wird vom Aufrufer aufgelöst; leer = alle
	Free     bool   // nur nicht zugewiesene
	Query    string
	Limit    int
}

func (s *Store) ListItems(ctx context.Context, f ListFilter) ([]Item, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", fmt.Sprintf("$%d", len(args))))
	}
	if len(f.States) > 0 {
		add("i.state = ANY(?::text[])", pgArray(f.States))
	}
	if f.Assignee != "" {
		add("i.assignee = ?", f.Assignee)
	}
	if f.Free {
		where = append(where, "i.assignee = ''")
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		args = append(args, "%"+q+"%", q)
		n := len(args)
		where = append(where, fmt.Sprintf("(i.file_name ILIKE $%d OR a.title ILIKE $%d OR i.asset_id = $%d)", n-1, n-1, n))
	}
	q := `SELECT ` + itemCols + itemFrom
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 200
	}
	q += fmt.Sprintf(` ORDER BY i.updated_at DESC LIMIT %d`, f.Limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func pgArray(v []string) any {
	// lib/pq / pgx: Text-Array als Literal {a,b}
	esc := make([]string, len(v))
	for i, s := range v {
		esc[i] = `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
	}
	return "{" + strings.Join(esc, ",") + "}"
}

// EnsureItem legt den Eintrag an, falls er fehlt (idempotent). created=true nur beim tatsächlichen Anlegen.
func (s *Store) EnsureItem(ctx context.Context, it Item, actor string) (bool, error) {
	tl, _ := json.Marshal(it.Timeline)
	if it.Timeline == nil {
		tl = nil
	}
	if it.ApprovalMode == "" {
		it.ApprovalMode = "single"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `INSERT INTO review_items (asset_id, source_version_id, source_rep_id, file_name, source_rev, size_bytes, format, ingest_job, state, approval_mode, timeline)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (asset_id) DO NOTHING`,
		it.AssetID, it.SourceVersionID, it.SourceRepID, it.FileName, it.SourceRev, it.SizeBytes, it.Format, it.IngestJob, StateAwaitingQC, it.ApprovalMode, tl)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 1 {
		if err := addHistory(ctx, tx, it.AssetID, actor, "registered", "", StateAwaitingQC, map[string]any{"file": it.FileName, "sourceRev": it.SourceRev}); err != nil {
			return false, err
		}
	}
	return n == 1, tx.Commit()
}

type execer interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func addHistory(ctx context.Context, tx execer, assetID, actor, action, from, to string, detail map[string]any) error {
	var raw []byte
	if detail != nil {
		raw, _ = json.Marshal(detail)
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO review_history (asset_id, actor, action, from_state, to_state, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
		assetID, actor, action, from, to, raw)
	return err
}

// History liefert den Verlauf (älteste zuerst).
func (s *Store) History(ctx context.Context, assetID string, limit int) ([]HistoryEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, asset_id, at, actor, action, from_state, to_state, detail FROM review_history WHERE asset_id=$1 ORDER BY id LIMIT $2`, assetID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryEntry
	for rows.Next() {
		var h HistoryEntry
		var d []byte
		if err := rows.Scan(&h.ID, &h.AssetID, &h.At, &h.Actor, &h.Action, &h.FromState, &h.ToState, &d); err != nil {
			return nil, err
		}
		if len(d) > 0 {
			_ = json.Unmarshal(d, &h.Detail)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// withItem sperrt den Eintrag (FOR UPDATE), ruft fn und schreibt die Änderungen zurück. Jede Mutation erhöht `revision`.
// expectedRev < 0 überspringt die Revisionsprüfung (interne Systemaktionen wie QC-Ergebnis).
func (s *Store) withItem(ctx context.Context, assetID string, expectedRev int64, fn func(tx *sql.Tx, it *Item) (action string, detail map[string]any, err error), actor string) (Item, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Item{}, err
	}
	defer func() { _ = tx.Rollback() }()
	it, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE i.asset_id=$1 FOR UPDATE OF i`, assetID))
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	if expectedRev >= 0 && it.Revision != expectedRev {
		return it, ErrConflict
	}
	before := it.State
	action, detail, err := fn(tx, &it)
	if errors.Is(err, errNoop) {
		return it, nil
	}
	if err != nil {
		return it, err
	}
	if it.State != before {
		if err := Transitions.Validate(before, it.State); err != nil {
			return it, fmt.Errorf("%w: %s → %s", ErrState, before, it.State)
		}
	}
	tl, _ := json.Marshal(it.Timeline)
	if it.Timeline == nil {
		tl = nil
	}
	var claimed any
	if it.ClaimedAt != nil {
		claimed = *it.ClaimedAt
	}
	if _, err := tx.ExecContext(ctx, `UPDATE review_items SET state=$2, assignee=$3, claimed_at=$4, revision=revision+1, qc_status=$5, qc_fail_count=$6, qc_warn_count=$7,
		qc_report_id=$8, timeline=$9, source_rev=$10, size_bytes=$11, source_version_id=$12, source_rep_id=$13, file_name=$14, format=$15, approval_mode=$16, updated_at=now() WHERE asset_id=$1`,
		it.AssetID, it.State, it.Assignee, claimed, it.QCStatus, it.QCFail, it.QCWarn, it.QCReportID, tl, it.SourceRev, it.SizeBytes, it.SourceVersionID, it.SourceRepID, it.FileName, it.Format, it.ApprovalMode); err != nil {
		return it, err
	}
	if action != "" {
		if err := addHistory(ctx, tx, it.AssetID, actor, action, before, it.State, detail); err != nil {
			return it, err
		}
	}
	if err := tx.Commit(); err != nil {
		return it, err
	}
	it.Revision++
	return it, nil
}

// ---- QC-Aufträge -------------------------------------------------------------------------------------------------

const jobCols = `id, asset_id, source_rev, profile_id, state, phase, progress, attempts, error, report_id, requested_by, created_at, started_at, finished_at`

func scanJob(r interface{ Scan(...any) error }) (Job, error) {
	var j Job
	var st, fin sql.NullTime
	err := r.Scan(&j.ID, &j.AssetID, &j.SourceRev, &j.ProfileID, &j.State, &j.Phase, &j.Progress, &j.Attempts, &j.Error, &j.ReportID, &j.RequestedBy, &j.CreatedAt, &st, &fin)
	if st.Valid {
		t := st.Time
		j.StartedAt = &t
	}
	if fin.Valid {
		t := fin.Time
		j.FinishedAt = &t
	}
	return j, err
}

// EnqueueJob legt einen QC-Auftrag an; existiert schon ein aktiver (queued/running) für das Asset, wird dieser geliefert
// (idempotent: doppeltes Auslösen startet keine zweite Analyse). created=false in diesem Fall.
func (s *Store) EnqueueJob(ctx context.Context, assetID, sourceRev, profileID, actor string) (Job, bool, error) {
	id := newID()
	_, err := s.db.ExecContext(ctx, `INSERT INTO qc_jobs (id, asset_id, source_rev, profile_id, state, requested_by) VALUES ($1,$2,$3,$4,'queued',$5)`, id, assetID, sourceRev, profileID, actor)
	if err == nil {
		j, e := s.GetJob(ctx, id)
		return j, true, e
	}
	if !isUniqueViolation(err) {
		return Job{}, false, err
	}
	j, e := scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobCols+` FROM qc_jobs WHERE asset_id=$1 AND state IN ('queued','running')`, assetID))
	return j, false, e
}

func isUniqueViolation(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "SQLSTATE 23505") || strings.Contains(err.Error(), "duplicate key"))
}

func (s *Store) GetJob(ctx context.Context, id string) (Job, error) {
	j, err := scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobCols+` FROM qc_jobs WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return j, ErrNotFound
	}
	return j, err
}

// ListJobs: Aufträge eines Assets (neueste zuerst).
func (s *Store) ListJobs(ctx context.Context, assetID string, limit int) ([]Job, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+jobCols+` FROM qc_jobs WHERE asset_id=$1 ORDER BY created_at DESC LIMIT $2`, assetID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ClaimJob nimmt den ältesten wartenden Auftrag (SKIP LOCKED: mehrere Worker/Orchestratoren nehmen nie denselben).
func (s *Store) ClaimJob(ctx context.Context) (*Job, error) {
	j, err := scanJob(s.db.QueryRowContext(ctx, `UPDATE qc_jobs SET state='running', started_at=now(), heartbeat_at=now(), attempts=attempts+1, phase='', progress=0
		WHERE id = (SELECT id FROM qc_jobs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING `+jobCols))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &j, nil
}

func (s *Store) JobProgress(ctx context.Context, id, phase string, pct int) {
	_, _ = s.db.ExecContext(ctx, `UPDATE qc_jobs SET phase=$2, progress=$3, heartbeat_at=now() WHERE id=$1 AND state='running'`, id, phase, pct)
}

// RequeueStale setzt „running“-Aufträge ohne Lebenszeichen zurück (Absturz/Neustart); nach maxAttempts → execution_failed.
func (s *Store) RequeueStale(ctx context.Context, olderThan time.Duration, maxAttempts int) ([]Job, error) {
	rows, err := s.db.QueryContext(ctx, `UPDATE qc_jobs SET state = CASE WHEN attempts >= $2 THEN 'execution_failed' ELSE 'queued' END,
		error = CASE WHEN attempts >= $2 THEN 'Abgebrochen: Prozess ohne Lebenszeichen (mehrfach)' ELSE error END,
		finished_at = CASE WHEN attempts >= $2 THEN now() ELSE finished_at END
		WHERE state='running' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING `+jobCols, olderThan.Seconds(), maxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// FailJob beendet einen Auftrag als „nicht ausführbar“.
func (s *Store) FailJob(ctx context.Context, id, msg string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE qc_jobs SET state='execution_failed', error=$2, finished_at=now() WHERE id=$1`, id, msg)
	return err
}

// CancelJob bricht einen wartenden/laufenden Auftrag ab.
func (s *Store) CancelJob(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE qc_jobs SET state='cancelled', finished_at=now() WHERE id=$1 AND state IN ('queued','running')`, id)
	return err
}

// ---- Berichte ----------------------------------------------------------------------------------------------------

// SaveReport speichert Bericht + Befunde und schließt den Auftrag ab — in einer Transaktion.
func (s *Store) SaveReport(ctx context.Context, job Job, out *QCOutput) (Report, error) {
	rep := Report{ID: newID(), JobID: job.ID, AssetID: job.AssetID, SourceRev: job.SourceRev, Overall: out.Overall, Counts: out.Counts, Streams: out.Streams, Tools: out.Tools,
		Ruleset: out.Profile.Ruleset(), CreatedAt: time.Now().UTC()}
	rep.Profile, _ = json.Marshal(out.Profile)
	counts, _ := json.Marshal(out.Counts)
	tools, _ := json.Marshal(out.Tools)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return rep, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO qc_reports (id, job_id, asset_id, source_rev, overall, counts, streams, tools, profile, ruleset, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		rep.ID, rep.JobID, rep.AssetID, rep.SourceRev, rep.Overall, counts, nullJSON(rep.Streams), tools, rep.Profile, rep.Ruleset, rep.CreatedAt); err != nil {
		return rep, err
	}
	for i := range out.Findings {
		f := &out.Findings[i]
		m, _ := json.Marshal(f.Measured)
		th, _ := json.Marshal(f.Threshold)
		if f.Measured == nil {
			m = nil
		}
		if f.Threshold == nil {
			th = nil
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO qc_findings (report_id, check_id, category, status, severity, message, measured, threshold, start_frame, end_frame, stream, tool, tool_version, analyzed_at, ruleset)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
			rep.ID, f.CheckID, f.Category, f.Status, f.Severity, f.Message, m, th, f.StartFrame, f.EndFrame, f.Stream, f.Tool, f.ToolVer, f.AnalyzedAt, f.Ruleset); err != nil {
			return rep, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE qc_jobs SET state='done', report_id=$2, finished_at=now(), error='' WHERE id=$1`, job.ID, rep.ID); err != nil {
		return rep, err
	}
	rep.Findings = out.Findings
	return rep, tx.Commit()
}

func nullJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return []byte(b)
}

func (s *Store) GetReport(ctx context.Context, id string, withFindings bool) (Report, error) {
	var r Report
	var counts, tools, streams, profile []byte
	err := s.db.QueryRowContext(ctx, `SELECT id, job_id, asset_id, source_rev, overall, counts, streams, tools, profile, ruleset, created_at FROM qc_reports WHERE id=$1`, id).
		Scan(&r.ID, &r.JobID, &r.AssetID, &r.SourceRev, &r.Overall, &counts, &streams, &tools, &profile, &r.Ruleset, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	_ = json.Unmarshal(counts, &r.Counts)
	_ = json.Unmarshal(tools, &r.Tools)
	r.Streams, r.Profile = streams, profile
	if withFindings {
		r.Findings, err = s.findings(ctx, id)
	}
	return r, err
}

func (s *Store) findings(ctx context.Context, reportID string) ([]Finding, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, check_id, category, status, severity, message, measured, threshold, start_frame, end_frame, stream, tool, tool_version, analyzed_at, ruleset FROM qc_findings WHERE report_id=$1 ORDER BY id`, reportID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Finding
	for rows.Next() {
		var f Finding
		var m, th []byte
		var sf, ef sql.NullInt64
		var st sql.NullInt32
		if err := rows.Scan(&f.ID, &f.CheckID, &f.Category, &f.Status, &f.Severity, &f.Message, &m, &th, &sf, &ef, &st, &f.Tool, &f.ToolVer, &f.AnalyzedAt, &f.Ruleset); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(m, &f.Measured)
		_ = json.Unmarshal(th, &f.Threshold)
		if sf.Valid {
			f.StartFrame = ptr(sf.Int64)
		}
		if ef.Valid {
			f.EndFrame = ptr(ef.Int64)
		}
		if st.Valid {
			f.Stream = ptr(int(st.Int32))
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ListReports: Berichte eines Assets ohne Befunde (neueste zuerst) — die Historie bleibt bei Wiederholung erhalten.
func (s *Store) ListReports(ctx context.Context, assetID string) ([]Report, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM qc_reports WHERE asset_id=$1 ORDER BY created_at DESC LIMIT 100`, assetID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	var out []Report
	for _, id := range ids {
		r, err := s.GetReport(ctx, id, false)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// ---- Conform -----------------------------------------------------------------------------------------------------

func scanConform(r interface{ Scan(...any) error }) (Conform, error) {
	var c Conform
	var ui, uo sql.NullInt64
	var meta []byte
	err := r.Scan(&c.ID, &c.AssetID, &c.Revision, &c.State, &c.SourceRev, &ui, &uo, &meta, &c.Note, &c.CreatedBy, &c.UpdatedBy, &c.CreatedAt, &c.UpdatedAt, &c.DecidedBy, &c.DecisionNote)
	if ui.Valid {
		c.UsableIn = ptr(ui.Int64)
	}
	if uo.Valid {
		c.UsableOut = ptr(uo.Int64)
	}
	_ = json.Unmarshal(meta, &c.AssetMetadata)
	return c, err
}

const conformCols = `id, asset_id, revision, state, source_rev, usable_in, usable_out, asset_metadata, note, created_by, updated_by, created_at, updated_at, decided_by, decision_note`

type queryer interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

func loadSegments(ctx context.Context, q queryer, conformID string) ([]Segment, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, ord, label, in_frame, out_frame, description, metadata, created_by, created_at, updated_at FROM conform_segments WHERE conform_id=$1 ORDER BY ord`, conformID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Segment{}
	for rows.Next() {
		var sg Segment
		var m []byte
		if err := rows.Scan(&sg.ID, &sg.Order, &sg.Label, &sg.In, &sg.Out, &sg.Description, &m, &sg.CreatedBy, &sg.CreatedAt, &sg.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(m, &sg.Metadata)
		out = append(out, sg)
	}
	return out, rows.Err()
}

// WorkingConform: der Entwurf, sonst die jüngste Revision (nil, wenn es noch keine gibt).
func (s *Store) WorkingConform(ctx context.Context, assetID string) (*Conform, error) {
	c, err := scanConform(s.db.QueryRowContext(ctx, `SELECT `+conformCols+` FROM conform_revisions WHERE asset_id=$1 ORDER BY (state='draft') DESC, revision DESC LIMIT 1`, assetID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Segments, err = loadSegments(ctx, s.db, c.ID)
	return &c, err
}

func (s *Store) GetConform(ctx context.Context, assetID string, revision int) (*Conform, error) {
	c, err := scanConform(s.db.QueryRowContext(ctx, `SELECT `+conformCols+` FROM conform_revisions WHERE asset_id=$1 AND revision=$2`, assetID, revision))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.Segments, err = loadSegments(ctx, s.db, c.ID)
	return &c, err
}

func (s *Store) ListConforms(ctx context.Context, assetID string) ([]Conform, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+conformCols+` FROM conform_revisions WHERE asset_id=$1 ORDER BY revision DESC`, assetID)
	if err != nil {
		return nil, err
	}
	var out []Conform
	for rows.Next() {
		c, err := scanConform(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, c)
	}
	rows.Close()
	for i := range out {
		if out[i].Segments, err = loadSegments(ctx, s.db, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

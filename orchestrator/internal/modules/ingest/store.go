package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrNotFound   = errors.New("ingest: nicht gefunden")
	ErrConflict   = errors.New("ingest: Revisionskonflikt — der Stand hat sich geändert")
	ErrState      = errors.New("ingest: Aktion im aktuellen Zustand nicht erlaubt")
	ErrValidation = errors.New("ingest: ungültige Eingabe")
	errNoop       = errors.New("ingest: no-op")
)

type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "ingest: ungültige Eingabe: " + strings.Join(e.Problems, "; ")
}
func (e *ValidationError) Is(t error) bool { return t == ErrValidation }

func newID() string { return tracing.NewID() }

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

const admissionLockKey = 424242017

func mj(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// ---- Zeitpläne ---------------------------------------------------------------------------------------------------

const schedCols = `id, name, enabled, revision, source, spec, profile_id, storage, metadata, priority, retry, late, host_pref, created_by, created_at, updated_at, cancelled_at, owner, owner_group, audio_plan`

func scanSchedule(r interface{ Scan(...any) error }) (Schedule, error) {
	var s Schedule
	var src, spec, stor, meta, retry, late, ap []byte
	var canc sql.NullTime
	err := r.Scan(&s.ID, &s.Name, &s.Enabled, &s.Revision, &src, &spec, &s.ProfileID, &stor, &meta, &s.Priority, &retry, &late, &s.HostPref, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt, &canc, &s.Owner, &s.OwnerGroup, &ap)
	if err != nil {
		return s, err
	}
	s.Audio = decodeAudio(ap)
	_ = json.Unmarshal(src, &s.Source)
	_ = json.Unmarshal(spec, &s.Spec)
	_ = json.Unmarshal(stor, &s.Storage)
	_ = json.Unmarshal(meta, &s.Metadata)
	_ = json.Unmarshal(retry, &s.Retry)
	_ = json.Unmarshal(late, &s.Late)
	if canc.Valid {
		t := canc.Time
		s.Cancelled = &t
	}
	return s, nil
}

func (s *Store) CreateSchedule(ctx context.Context, sc Schedule) (Schedule, error) {
	sc.ID = newID()
	sc.Revision = 1
	_, err := s.db.ExecContext(ctx, `INSERT INTO ingest_schedules (id, name, enabled, revision, source, spec, profile_id, storage, metadata, priority, retry, late, host_pref, created_by, owner, owner_group, audio_plan)
		VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		sc.ID, sc.Name, sc.Enabled, mj(sc.Source), mj(sc.Spec), sc.ProfileID, mj(sc.Storage), mj(orEmpty(sc.Metadata)), sc.Priority, mj(sc.Retry), mj(sc.Late), sc.HostPref, sc.CreatedBy, sc.Owner, sc.OwnerGroup, encodeAudio(sc.Audio))
	if err != nil {
		return sc, err
	}
	return s.GetSchedule(ctx, sc.ID)
}

// encodeAudio/decodeAudio: JSONB-Spalte audio_plan (NULL = kein Plan).
func encodeAudio(p *AudioPlan) any {
	if p == nil {
		return nil
	}
	b, _ := json.Marshal(p)
	return b
}

func decodeAudio(raw []byte) *AudioPlan {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var p AudioPlan
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	return &p
}

func splitKeys(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func (s *Store) GetSchedule(ctx context.Context, id string) (Schedule, error) {
	sc, err := scanSchedule(s.db.QueryRowContext(ctx, `SELECT `+schedCols+` FROM ingest_schedules WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return sc, ErrNotFound
	}
	return sc, err
}

func (s *Store) ListSchedules(ctx context.Context, includeCancelled bool) ([]Schedule, error) {
	q := `SELECT ` + schedCols + ` FROM ingest_schedules`
	if !includeCancelled {
		q += ` WHERE cancelled_at IS NULL`
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Schedule
	for rows.Next() {
		sc, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// UpdateSchedule ersetzt die Felder (optimistisch über Revision).
func (s *Store) UpdateSchedule(ctx context.Context, sc Schedule, expectedRev int) (Schedule, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE ingest_schedules SET name=$2, enabled=$3, source=$4, spec=$5, profile_id=$6, storage=$7, metadata=$8, priority=$9, retry=$10, late=$11, host_pref=$12, owner=$14, owner_group=$15, audio_plan=$16,
		revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$13 AND cancelled_at IS NULL`,
		sc.ID, sc.Name, sc.Enabled, mj(sc.Source), mj(sc.Spec), sc.ProfileID, mj(sc.Storage), mj(orEmpty(sc.Metadata)), sc.Priority, mj(sc.Retry), mj(sc.Late), sc.HostPref, expectedRev, sc.Owner, sc.OwnerGroup, encodeAudio(sc.Audio))
	if err != nil {
		return sc, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, e := s.GetSchedule(ctx, sc.ID); errors.Is(e, ErrNotFound) {
			return sc, ErrNotFound
		}
		return sc, ErrConflict
	}
	return s.GetSchedule(ctx, sc.ID)
}

func (s *Store) CancelSchedule(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ingest_schedules SET cancelled_at=now(), enabled=false, revision=revision+1, updated_at=now() WHERE id=$1 AND cancelled_at IS NULL`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Aufträge ----------------------------------------------------------------------------------------------------

const jobCols = `id, schedule_id, idempotency_key, name, planned_start, planned_end, tz, shifted, ambiguous, state, state_since, attempt, max_attempts, priority, source, profile_id, host_pref, host_id, instance_id,
 file_rel, file_path, asset_id, actual_start, actual_end, start_deviation_ms, error, failed_stage, verdicts, earliest_start, storage, metadata, late, revision, created_by, created_at, updated_at, owner, owner_group, audio_plan`

func scanJob(r interface{ Scan(...any) error }) (Job, error) {
	var j Job
	var src, verd, stor, meta, late, ap []byte
	var as, ae, es sql.NullTime
	var dev sql.NullInt64
	err := r.Scan(&j.ID, &j.ScheduleID, &j.Key, &j.Name, &j.PlannedStart, &j.PlannedEnd, &j.TZ, &j.Shifted, &j.Ambiguous, &j.State, &j.StateSince, &j.Attempt, &j.MaxAttempts, &j.Priority, &src, &j.ProfileID, &j.HostPref, &j.HostID, &j.InstanceID,
		&j.FileRel, &j.FilePath, &j.AssetID, &as, &ae, &dev, &j.Error, &j.FailedStage, &verd, &es, &stor, &meta, &late, &j.Revision, &j.CreatedBy, &j.CreatedAt, &j.UpdatedAt, &j.Owner, &j.OwnerGroup, &ap)
	if err != nil {
		return j, err
	}
	j.Audio = decodeAudio(ap)
	_ = json.Unmarshal(src, &j.Source)
	_ = json.Unmarshal(verd, &j.Verdicts)
	_ = json.Unmarshal(stor, &j.Storage)
	_ = json.Unmarshal(meta, &j.Metadata)
	_ = json.Unmarshal(late, &j.Late)
	if as.Valid {
		t := as.Time
		j.ActualStart = &t
	}
	if ae.Valid {
		t := ae.Time
		j.ActualEnd = &t
	}
	if es.Valid {
		t := es.Time
		j.EarliestStart = &t
	}
	if dev.Valid {
		v := dev.Int64
		j.DeviationMs = &v
	}
	return j, nil
}

func (s *Store) GetJob(ctx context.Context, id string) (Job, error) {
	j, err := scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobCols+` FROM ingest_jobs WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return j, ErrNotFound
	}
	return j, err
}

type JobFilter struct {
	States     []string
	ScheduleID string
	From, To   *time.Time // Überschneidung mit [From, To)
	Limit      int
}

func (s *Store) ListJobs(ctx context.Context, f JobFilter) ([]Job, error) {
	var where []string
	var args []any
	add := func(c string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(c, "?", fmt.Sprintf("$%d", len(args))))
	}
	if len(f.States) > 0 {
		add("state = ANY(?::text[])", "{"+strings.Join(f.States, ",")+"}")
	}
	if f.ScheduleID != "" {
		add("schedule_id = ?", f.ScheduleID)
	}
	if f.From != nil {
		add("planned_end > ?", *f.From)
	}
	if f.To != nil {
		add("planned_start < ?", *f.To)
	}
	q := `SELECT ` + jobCols + ` FROM ingest_jobs`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 300
	}
	rows, err := s.db.QueryContext(ctx, q+fmt.Sprintf(` ORDER BY planned_start DESC LIMIT %d`, f.Limit), args...)
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

// CreateJob legt einen Auftrag an — **idempotent über den Schlüssel**: existiert er schon, wird der bestehende geliefert (created=false).
func (s *Store) CreateJob(ctx context.Context, j Job) (Job, bool, error) {
	j.ID = newID()
	res, err := s.db.ExecContext(ctx, `INSERT INTO ingest_jobs (id, schedule_id, idempotency_key, occurrence_index, name, planned_start, planned_end, tz, shifted, ambiguous, state, max_attempts, priority, source, source_key, profile_id,
		host_pref, storage, metadata, late, created_by, owner, owner_group, audio_plan, extra_source_keys) VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT (idempotency_key) DO NOTHING`,
		j.ID, j.ScheduleID, j.Key, j.Name, j.PlannedStart, j.PlannedEnd, j.TZ, j.Shifted, j.Ambiguous, StBlocked, j.MaxAttempts, j.Priority, mj(j.Source), j.Source.Key(), j.ProfileID,
		j.HostPref, mj(j.Storage), mj(orEmpty(j.Metadata)), mj(j.Late), j.CreatedBy, j.Owner, j.OwnerGroup, encodeAudio(j.Audio), strings.Join(j.Audio.ExtraKeys(), "\n"))
	if err != nil {
		return j, false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		got, err := scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobCols+` FROM ingest_jobs WHERE idempotency_key=$1`, j.Key))
		return got, false, err
	}
	_ = s.addEvent(ctx, s.db, j.ID, "", StBlocked, "angelegt", nil)
	got, err := s.GetJob(ctx, j.ID)
	return got, true, err
}

type execer interface {
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func (s *Store) addEvent(ctx context.Context, x execer, jobID, from, to, msg string, detail map[string]any) error {
	var raw []byte
	if detail != nil {
		raw = mj(detail)
	}
	_, err := x.ExecContext(ctx, `INSERT INTO ingest_job_events (job_id, from_state, to_state, message, detail) VALUES ($1,$2,$3,$4,$5)`, jobID, from, to, msg, raw)
	return err
}

func (s *Store) Events(ctx context.Context, jobID string) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, job_id, at, from_state, to_state, message, detail FROM ingest_job_events WHERE job_id=$1 ORDER BY id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var d []byte
		if err := rows.Scan(&e.ID, &e.JobID, &e.At, &e.FromState, &e.ToState, &e.Message, &d); err != nil {
			return nil, err
		}
		if len(d) > 0 {
			_ = json.Unmarshal(d, &e.Detail)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Mutate sperrt den Auftrag, wendet fn an und schreibt zurück. Zustandswechsel werden gegen Transitions geprüft und als Ereignis
// protokolliert. expectedRev < 0 überspringt die Revisionsprüfung (interne Systemaktionen).
func (s *Store) Mutate(ctx context.Context, id string, expectedRev int, msg string, fn func(j *Job) (detail map[string]any, err error)) (Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback() }()
	j, err := scanJob(tx.QueryRowContext(ctx, `SELECT `+jobCols+` FROM ingest_jobs WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, err
	}
	if expectedRev >= 0 && j.Revision != expectedRev {
		return j, ErrConflict
	}
	before := j.State
	detail, err := fn(&j)
	if errors.Is(err, errNoop) {
		return j, nil
	}
	if err != nil {
		return j, err
	}
	if j.State != before {
		if e := Transitions.Validate(before, j.State); e != nil {
			return j, fmt.Errorf("%w: %s → %s", ErrState, before, j.State)
		}
		j.StateSince = time.Now().UTC()
	}
	var as, ae, es any
	if j.ActualStart != nil {
		as = *j.ActualStart
	}
	if j.ActualEnd != nil {
		ae = *j.ActualEnd
	}
	if j.EarliestStart != nil {
		es = *j.EarliestStart
	}
	var dev any
	if j.DeviationMs != nil {
		dev = *j.DeviationMs
	}
	var verd any
	if j.Verdicts != nil {
		verd = mj(j.Verdicts)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ingest_jobs SET name=$2, planned_start=$3, planned_end=$4, state=$5, state_since=$6, attempt=$7, max_attempts=$8, priority=$9, source=$10, source_key=$11, profile_id=$12,
		host_pref=$13, host_id=$14, instance_id=$15, file_rel=$16, file_path=$17, asset_id=$18, actual_start=$19, actual_end=$20, start_deviation_ms=$21, error=$22, failed_stage=$23, verdicts=$24, earliest_start=$25,
		storage=$26, metadata=$27, late=$28, owner=$29, owner_group=$30, shifted=$31, ambiguous=$32, tz=$33, audio_plan=$34, extra_source_keys=$35, revision=revision+1, updated_at=now() WHERE id=$1`,
		j.ID, j.Name, j.PlannedStart, j.PlannedEnd, j.State, j.StateSince, j.Attempt, j.MaxAttempts, j.Priority, mj(j.Source), j.Source.Key(), j.ProfileID, j.HostPref, j.HostID, j.InstanceID, j.FileRel, j.FilePath, j.AssetID,
		as, ae, dev, j.Error, j.FailedStage, verd, es, mj(j.Storage), mj(orEmpty(j.Metadata)), mj(j.Late), j.Owner, j.OwnerGroup, j.Shifted, j.Ambiguous, j.TZ, encodeAudio(j.Audio), strings.Join(j.Audio.ExtraKeys(), "\n")); err != nil {
		return j, err
	}
	if msg != "" || j.State != before {
		if err := s.addEvent(ctx, tx, j.ID, before, j.State, msg, detail); err != nil {
			return j, err
		}
	}
	if Terminal(j.State) && !Terminal(before) {
		if _, err := tx.ExecContext(ctx, `UPDATE ingest_reservations SET state='released' WHERE job_id=$1 AND state<>'released'`, j.ID); err != nil {
			return j, err
		}
	}
	if err := tx.Commit(); err != nil {
		return j, err
	}
	j.Revision++
	return j, nil
}

// ---- Reservierungen & Zulassung ------------------------------------------------------------------------------------

type Reservation struct {
	JobID    string    `json:"jobId"`
	Host     string    `json:"host"`
	Resource string    `json:"resource"`
	Amount   float64   `json:"amount"`
	Origin   string    `json:"origin,omitempty"`
	From     time.Time `json:"from"`
	To       time.Time `json:"to"`
	State    string    `json:"state"`
}

func loadBooked(ctx context.Context, q interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
}, now time.Time, excludeJob string) ([]Booked, error) {
	rows, err := q.QueryContext(ctx, `SELECT r.job_id, r.host_id, r.resource, r.amount, r.t_start, r.t_end, j.priority, j.source_key, j.state, j.extra_source_keys
		FROM ingest_reservations r JOIN ingest_jobs j ON j.id = r.job_id
		WHERE r.state <> 'released' AND r.t_end > $1 AND r.job_id <> $2 ORDER BY r.job_id`, now, excludeJob)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byJob := map[string]*Booked{}
	var order []string
	for rows.Next() {
		var job, host, res, src, st, extra string
		var amt float64
		var ts, te time.Time
		var prio int
		if err := rows.Scan(&job, &host, &res, &amt, &ts, &te, &prio, &src, &st, &extra); err != nil {
			return nil, err
		}
		b, ok := byJob[job]
		if !ok {
			b = &Booked{JobID: job, Host: host, Source: src, Extra: splitKeys(extra), Start: ts, End: te, Priority: prio, Amount: map[string]float64{}, Active: st == StRecording || st == StStarting || st == StFinalizing || st == StProcessing}
			byJob[job] = b
			order = append(order, job)
		}
		b.Amount[res] = amt
	}
	out := make([]Booked, 0, len(order))
	for _, id := range order {
		out = append(out, *byJob[id])
	}
	return out, rows.Err()
}

// Admit bewertet und reserviert **atomar**: Ein Advisory-Lock serialisiert alle Zulassungsentscheidungen, die Buchungen werden
// innerhalb derselben Transaktion gelesen und geschrieben — parallele Entscheidungen können dieselbe Kapazität nicht doppelt
// vergeben. Das Ergebnis (zugelassen oder blockiert samt Gründen) wird am Auftrag festgehalten.
func (s *Store) Admit(ctx context.Context, jobID string, hosts []HostCap, demand Demand, needs []string, rules Rules, now time.Time) (Decision, Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Decision{}, Job{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, admissionLockKey); err != nil {
		return Decision{}, Job{}, err
	}
	j, err := scanJob(tx.QueryRowContext(ctx, `SELECT `+jobCols+` FROM ingest_jobs WHERE id=$1 FOR UPDATE`, jobID))
	if errors.Is(err, sql.ErrNoRows) {
		return Decision{}, Job{}, ErrNotFound
	}
	if err != nil {
		return Decision{}, j, err
	}
	if Terminal(j.State) || Active(j.State) {
		return Decision{}, j, fmt.Errorf("%w: Zustand %s", ErrState, j.State)
	}
	booked, err := loadBooked(ctx, tx, now, jobID)
	if err != nil {
		return Decision{}, j, err
	}
	d := Plan(Request{JobID: jobID, Source: j.Source.Key(), Extra: j.Audio.ExtraKeys(), Start: j.PlannedStart, End: j.PlannedEnd, Priority: j.Priority, Demand: demand, HostPref: j.HostPref, Needs: needs}, hosts, booked, rules, now)
	before := j.State
	if _, err := tx.ExecContext(ctx, `UPDATE ingest_reservations SET state='released' WHERE job_id=$1 AND state<>'released'`, jobID); err != nil {
		return d, j, err
	}
	var es any
	if d.EarliestStart != nil {
		es = *d.EarliestStart
	}
	newState := StBlocked
	host := ""
	if d.Admit {
		newState, host = StScheduled, d.Host
		for _, r := range ResourceKinds {
			if amt := demand.Amount[r]; amt > 0 {
				if _, err := tx.ExecContext(ctx, `INSERT INTO ingest_reservations (job_id, host_id, resource, amount, origin, t_start, t_end, state) VALUES ($1,$2,$3,$4,$5,$6,$7,'held')`,
					jobID, host, r, amt, demand.Origin[r], j.PlannedStart, j.PlannedEnd); err != nil {
					return d, j, err
				}
			}
		}
	}
	if newState != before {
		if err := Transitions.Validate(before, newState); err != nil {
			return d, j, fmt.Errorf("%w: %s → %s", ErrState, before, newState)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ingest_jobs SET state=$2, state_since = CASE WHEN state<>$2 THEN now() ELSE state_since END, host_id=$3, verdicts=$4, earliest_start=$5, revision=revision+1, updated_at=now() WHERE id=$1`,
		jobID, newState, host, mj(d.Verdicts), es); err != nil {
		return d, j, err
	}
	msg := "zugelassen auf Host " + host
	if !d.Admit {
		msg = "nicht zugelassen"
		if len(d.Verdicts) > 0 {
			msg += ": " + d.Verdicts[0].Message
		}
	}
	if newState != before || !d.Admit {
		if err := s.addEvent(ctx, tx, jobID, before, newState, msg, map[string]any{"verdicts": d.Verdicts}); err != nil {
			return d, j, err
		}
	}
	if err := tx.Commit(); err != nil {
		return d, j, err
	}
	got, err := s.GetJob(ctx, jobID)
	return d, got, err
}

func (s *Store) ReleaseReservations(ctx context.Context, jobID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ingest_reservations SET state='released' WHERE job_id=$1 AND state<>'released'`, jobID)
	return err
}

// ActivateReservations markiert die Reservierungen eines laufenden Auftrags (zählen dann als „nicht verdrängbar“).
func (s *Store) ActivateReservations(ctx context.Context, jobID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ingest_reservations SET state='active' WHERE job_id=$1 AND state='held'`, jobID)
	return err
}

// Booked liefert alle noch nicht beendeten Buchungen (für Kapazitätsansicht und Neubewertung).
func (s *Store) Booked(ctx context.Context, now time.Time) ([]Booked, error) {
	return loadBooked(ctx, s.db, now, "")
}

// ---- Messwerte je Profil ------------------------------------------------------------------------------------------

func (s *Store) Stats(ctx context.Context, profile string) (*Stats, error) {
	var st Stats
	err := s.db.QueryRowContext(ctx, `SELECT samples, bytes_per_s, cpu_p95, mem_mb FROM ingest_profile_stats WHERE profile_id=$1`, profile).Scan(&st.Samples, &st.BytesPerS, &st.CPUP95, &st.MemMB)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &st, err
}

// RecordStats führt eine Messung ein (gleitender Mittelwert für die Rate, Maximum für CPU/Speicher — konservativ).
func (s *Store) RecordStats(ctx context.Context, profile string, bytesPerS, cpu, memMB float64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO ingest_profile_stats (profile_id, samples, bytes_per_s, cpu_p95, mem_mb) VALUES ($1,1,$2,$3,$4)
		ON CONFLICT (profile_id) DO UPDATE SET samples = ingest_profile_stats.samples + 1,
		  bytes_per_s = (ingest_profile_stats.bytes_per_s * ingest_profile_stats.samples + $2) / (ingest_profile_stats.samples + 1),
		  cpu_p95 = GREATEST(ingest_profile_stats.cpu_p95, $3), mem_mb = GREATEST(ingest_profile_stats.mem_mb, $4), updated_at = now()`, profile, bytesPerS, cpu, memMB)
	return err
}

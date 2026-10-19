package ingest

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// HostInfo: gemessene/erkannte Eigenschaften eines Hosts („local“ = Orchestrator-Host).
type HostInfo struct {
	ID          string
	Label       string
	Online      bool
	Maintenance bool
	CPUCores    float64
	MemTotalMB  float64
	DiskFreeGB  float64
}

type Service struct {
	St      *Store
	Cfg     func() Config
	Runtime Runtime
	Assets  *asset.Store
	Hosts   func(ctx context.Context) []HostInfo
	Audit   module.DomainAudit
	Log     *slog.Logger
	Now     func() time.Time
	FFmpeg  string // für die Nachbearbeitung

	mu       sync.Mutex
	inflight map[string]bool
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Service) audit(actor, id, action string, d map[string]any) {
	if s.Audit != nil {
		s.Audit.Log(actor, "ingest", id, action, d)
	}
}

// ---- Kapazität ----------------------------------------------------------------------------------------------------

// CapacityHosts: Hostbudgets = Konfiguration (je Host oder Standard), begrenzt durch erkannte Werte (RAM/Platz) — nie über der Hardware.
func (s *Service) CapacityHosts(ctx context.Context) []HostCap {
	cfg := s.Cfg()
	infos := []HostInfo{{ID: "local", Label: "Orchestrator-Host", Online: true}}
	if s.Hosts != nil {
		infos = s.Hosts(ctx)
	}
	var out []HostCap
	for _, h := range infos {
		b, ok := cfg.HostBudgets[h.ID]
		if !ok {
			b = cfg.DefaultBudget
		}
		hard := map[string]float64{}
		for k, v := range b.Hard {
			hard[k] = v
		}
		if !ok { // keine ausdrückliche Konfiguration → erkannte Hardware begrenzt die Standardwerte
			if h.MemTotalMB > 0 && hard[ResMem] > h.MemTotalMB*0.75 {
				hard[ResMem] = h.MemTotalMB * 0.75
			}
			if h.CPUCores > 0 && hard[ResCPU] > h.CPUCores*0.8 {
				hard[ResCPU] = h.CPUCores * 0.8
			}
		}
		if h.DiskFreeGB > 0 && (hard[ResDiskGB] == 0 || hard[ResDiskGB] > h.DiskFreeGB) {
			hard[ResDiskGB] = h.DiskFreeGB
		}
		fns := b.Functions
		if len(fns) == 0 {
			fns = cfg.DefaultBudget.Functions
		}
		out = append(out, HostCap{ID: h.ID, Label: h.Label, Online: h.Online && !h.Maintenance, Functions: fns, Hard: hard, SoftFrac: b.SoftFrac})
	}
	return out
}

func (c Config) planRules() Rules {
	return Rules{ReservePct: c.Rules.ReservePct, ReserveFromPriority: c.Rules.ReserveFromPriority, SourceLimit: c.Rules.SourceLimit, SourceOverride: c.Rules.SourceOverride, AllowPreempt: c.Rules.AllowPreempt}
}

func (s *Service) demandFor(ctx context.Context, j Job) (Demand, error) {
	cfg := s.Cfg()
	p, ok := cfg.Profiles[j.ProfileID]
	if !ok {
		return Demand{}, fmt.Errorf("%w: Profil %q existiert nicht", ErrValidation, j.ProfileID)
	}
	st, err := s.St.Stats(ctx, j.ProfileID)
	if err != nil {
		return Demand{}, err
	}
	return EffectiveDemand(p, st, j.PlannedEnd.Sub(j.PlannedStart).Seconds()), nil
}

// Admit bewertet einen Auftrag neu (atomar).
func (s *Service) Admit(ctx context.Context, id string) (Decision, Job, error) {
	j, err := s.St.GetJob(ctx, id)
	if err != nil {
		return Decision{}, j, err
	}
	d, err := s.demandFor(ctx, j)
	if err != nil {
		return Decision{}, j, err
	}
	dec, job, err := s.St.Admit(ctx, id, s.CapacityHosts(ctx), d, []string{"recorder"}, s.Cfg().planRules(), s.now())
	if err == nil && !dec.Admit && j.State != StBlocked {
		metrics.AdmitRejected.Add(1)
	}
	return dec, job, err
}

// ---- Zeitpläne ----------------------------------------------------------------------------------------------------

// ScheduleInput: Eingabe beim Anlegen/Ändern.
type ScheduleInput struct {
	Name      string         `json:"name"`
	Enabled   *bool          `json:"enabled"`
	Source    Source         `json:"source"`
	Spec      Spec           `json:"spec"`
	ProfileID string         `json:"profileId"`
	Storage   Storage        `json:"storage"`
	Metadata  map[string]any `json:"metadata"`
	Priority  *int           `json:"priority"`
	Retry     RetryPolicy    `json:"retry"`
	Late      LatePolicy     `json:"late"`
	HostPref  string         `json:"hostPref"`
	// Owner/OwnerGroup: verantwortliche Person bzw. Gruppe (Kapitel 44); beide leer = bei Neuanlage der Ersteller, bei Änderung unverändert.
	Owner      string `json:"owner"`
	OwnerGroup string `json:"ownerGroup"`
}

var safeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func (s *Service) validate(in *ScheduleInput) error {
	cfg := s.Cfg()
	var p []string
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		p = append(p, "Name fehlt")
	}
	if in.Source.Key() == "unknown" {
		p = append(p, "Quelle fehlt (Instanz oder Sender)")
	}
	if _, ok := cfg.Profiles[in.ProfileID]; !ok {
		p = append(p, fmt.Sprintf("Profil %q unbekannt", in.ProfileID))
	}
	if err := in.Spec.Validate(); err != nil {
		p = append(p, err.Error())
	}
	in.Owner, in.OwnerGroup = strings.TrimSpace(in.Owner), strings.TrimSpace(in.OwnerGroup)
	if len(in.Owner) > 100 || len(in.OwnerGroup) > 100 {
		p = append(p, "Verantwortliche(r) zu lang")
	}
	if in.Priority != nil && (*in.Priority < 0 || *in.Priority > 9) {
		p = append(p, "Priorität muss 0–9 sein")
	}
	if err := in.Late.validate(); err != nil {
		p = append(p, err.Error())
	}
	if in.Retry.MaxAttempts < 0 || in.Retry.MaxAttempts > 10 {
		p = append(p, "Versuche müssen 0–10 sein")
	}
	if d := filepath.Clean("/" + in.Storage.Dir); strings.Contains(in.Storage.Dir, "..") || (in.Storage.Dir != "" && d == "/") {
		p = append(p, "Zielverzeichnis ungültig")
	}
	if strings.ContainsAny(in.Storage.FileTemplate, "/\\") {
		p = append(p, "Dateivorlage darf keine Pfadtrenner enthalten")
	}
	if len(p) > 0 {
		return &ValidationError{Problems: p}
	}
	return nil
}

func (s *Service) toSchedule(in ScheduleInput, actor string) Schedule {
	cfg := s.Cfg()
	sc := Schedule{Name: in.Name, Enabled: true, Source: in.Source, Spec: in.Spec, ProfileID: in.ProfileID, Storage: in.Storage, Metadata: in.Metadata, Priority: 5,
		Retry: in.Retry, Late: in.Late, HostPref: in.HostPref, CreatedBy: actor, Owner: in.Owner, OwnerGroup: in.OwnerGroup}
	if sc.Owner == "" && sc.OwnerGroup == "" {
		sc.Owner = actor
	}
	if in.Enabled != nil {
		sc.Enabled = *in.Enabled
	}
	if in.Priority != nil {
		sc.Priority = *in.Priority
	}
	if sc.Late.Mode == "" {
		sc.Late = cfg.DefaultLate
	}
	if sc.Retry.MaxAttempts == 0 {
		sc.Retry = cfg.DefaultRetry
	}
	return sc
}

func (s *Service) CreateSchedule(ctx context.Context, in ScheduleInput, actor string) (Schedule, error) {
	if err := s.validate(&in); err != nil {
		return Schedule{}, err
	}
	sc, err := s.St.CreateSchedule(ctx, s.toSchedule(in, actor))
	if err != nil {
		return sc, err
	}
	s.audit(actor, sc.ID, "schedule_created", map[string]any{"name": sc.Name})
	_, _ = s.Materialize(ctx, sc)
	return sc, nil
}

// UpdateSchedule ändert einen Zeitplan. Noch nicht gestartete Aufträge werden verworfen und neu berechnet; **laufende Aufnahmen
// bleiben unberührt** (nie automatisch unterbrochen).
func (s *Service) UpdateSchedule(ctx context.Context, id string, in ScheduleInput, expectedRev int, actor string) (Schedule, error) {
	if err := s.validate(&in); err != nil {
		return Schedule{}, err
	}
	old, err := s.St.GetSchedule(ctx, id)
	if err != nil {
		return old, err
	}
	n := s.toSchedule(in, old.CreatedBy)
	if in.Owner == "" && in.OwnerGroup == "" {
		n.Owner, n.OwnerGroup = old.Owner, old.OwnerGroup
	}
	n.ID = id
	sc, err := s.St.UpdateSchedule(ctx, n, expectedRev)
	if err != nil {
		return sc, err
	}
	s.audit(actor, id, "schedule_updated", map[string]any{"revision": sc.Revision})
	s.refreshFutureJobs(ctx, sc, "Zeitplan geändert")
	_, _ = s.Materialize(ctx, sc)
	return sc, nil
}

// CancelSchedule beendet einen Zeitplan; künftige Aufträge werden abgebrochen, laufende laufen aus (abortRunning bricht sie ab).
func (s *Service) CancelSchedule(ctx context.Context, id, actor string, abortRunning bool) error {
	if err := s.St.CancelSchedule(ctx, id); err != nil {
		return err
	}
	s.dropFutureJobs(ctx, id, "Zeitplan beendet", actor)
	if abortRunning {
		jobs, _ := s.St.ListJobs(ctx, JobFilter{ScheduleID: id, States: []string{StStarting, StRecording, StWaiting}})
		for _, j := range jobs {
			_, _ = s.CancelJob(ctx, j.ID, actor, true, -1)
		}
	}
	s.audit(actor, id, "schedule_cancelled", nil)
	return nil
}

// refreshFutureJobs gleicht die noch nicht gestarteten Aufträge nach einer Änderung des Zeitplans ab: Vorkommen, die es weiter gibt
// (gleicher Schlüssel), werden an Ort und Stelle aktualisiert und neu zugelassen — **nicht** abgebrochen, sonst bliebe der Auftrag wegen
// des Idempotenzschlüssels für immer abgebrochen (z. B. wenn nur der Name oder die Verantwortlichen geändert wurden); Vorkommen, die
// entfallen (Zeit, Wiederholung, deaktiviert), werden abgebrochen. Neue Vorkommen legt danach Materialize an.
func (s *Service) refreshFutureJobs(ctx context.Context, sc Schedule, why string) {
	jobs, err := s.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID, States: []string{StBlocked, StScheduled, StWaiting}})
	if err != nil {
		return
	}
	keep := map[string]Occurrence{}
	if sc.Enabled && sc.Cancelled == nil {
		cfg, now := s.Cfg(), s.now()
		if occ, err := Occurrences(sc.Spec, now.Add(-time.Minute), now.Add(time.Duration(cfg.HorizonHours)*time.Hour)); err == nil {
			for _, o := range occ {
				keep[IdempotencyKey(sc.ID, o)] = o
			}
		}
	}
	for _, j := range jobs {
		o, stays := keep[j.Key]
		_, err := s.St.Mutate(ctx, j.ID, -1, why, func(x *Job) (map[string]any, error) {
			if !stays {
				x.State, x.Error = StCancelled, ""
				return nil, nil
			}
			x.Name, x.PlannedStart, x.PlannedEnd, x.TZ, x.Shifted, x.Ambiguous = sc.Name, o.Start, o.End, sc.Spec.TZ, o.Shifted, o.Ambiguous
			x.MaxAttempts, x.Priority, x.Source, x.ProfileID, x.HostPref = sc.Retry.MaxAttempts, sc.Priority, sc.Source, sc.ProfileID, sc.HostPref
			x.Storage, x.Metadata, x.Late, x.Owner, x.OwnerGroup = sc.Storage, sc.Metadata, sc.Late, sc.Owner, sc.OwnerGroup
			return nil, nil
		})
		if err != nil {
			s.log().Warn("Auftrag nicht aktualisiert", "job", j.ID, "error", err)
			continue
		}
		if stays && j.State != StWaiting {
			if _, _, err := s.Admit(ctx, j.ID); err != nil && !isStateErr(err) {
				s.log().Warn("Neuzulassung fehlgeschlagen", "job", j.ID, "error", err)
			}
		}
	}
}

func (s *Service) dropFutureJobs(ctx context.Context, scheduleID, why, actor string) {
	jobs, err := s.St.ListJobs(ctx, JobFilter{ScheduleID: scheduleID, States: []string{StBlocked, StScheduled, StWaiting}})
	if err != nil {
		return
	}
	for _, j := range jobs {
		if _, err := s.St.Mutate(ctx, j.ID, -1, why, func(x *Job) (map[string]any, error) {
			x.State = StCancelled
			x.Error = ""
			return nil, nil
		}); err != nil {
			s.log().Warn("Auftrag nicht verworfen", "job", j.ID, "error", err)
		}
	}
}

// Materialize erzeugt für alle Vorkommen im Planungshorizont je genau einen Auftrag (idempotent) und lässt ihn zu.
func (s *Service) Materialize(ctx context.Context, sc Schedule) (int, error) {
	if !sc.Enabled || sc.Cancelled != nil {
		return 0, nil
	}
	cfg := s.Cfg()
	now := s.now()
	occ, err := Occurrences(sc.Spec, now.Add(-time.Minute), now.Add(time.Duration(cfg.HorizonHours)*time.Hour))
	if err != nil {
		return 0, err
	}
	created := 0
	for _, o := range occ {
		j, isNew, err := s.St.CreateJob(ctx, Job{ScheduleID: sc.ID, Key: IdempotencyKey(sc.ID, o), Name: sc.Name, PlannedStart: o.Start, PlannedEnd: o.End, TZ: sc.Spec.TZ,
			Shifted: o.Shifted, Ambiguous: o.Ambiguous, MaxAttempts: sc.Retry.MaxAttempts, Priority: sc.Priority, Source: sc.Source, ProfileID: sc.ProfileID, HostPref: sc.HostPref,
			Storage: sc.Storage, Metadata: sc.Metadata, Late: sc.Late, CreatedBy: sc.CreatedBy, Owner: sc.Owner, OwnerGroup: sc.OwnerGroup})
		if err != nil {
			return created, err
		}
		if isNew {
			created++
		}
		if j.State == StBlocked || (isNew && j.State != StScheduled) {
			if _, _, err := s.Admit(ctx, j.ID); err != nil && !isStateErr(err) {
				s.log().Warn("Zulassung fehlgeschlagen", "job", j.ID, "error", err)
			}
		}
	}
	return created, nil
}

func isStateErr(err error) bool { return err != nil && strings.Contains(err.Error(), "nicht erlaubt") }

// MaterializeAll: periodisch; zusätzlich werden blockierte Aufträge neu bewertet (Kapazität kann frei geworden sein).
func (s *Service) MaterializeAll(ctx context.Context) {
	scs, err := s.St.ListSchedules(ctx, false)
	if err != nil {
		s.log().Warn("Zeitpläne nicht lesbar", "error", err)
		return
	}
	for _, sc := range scs {
		if _, err := s.Materialize(ctx, sc); err != nil {
			s.log().Warn("Zeitplan nicht auswertbar", "schedule", sc.ID, "error", err)
		}
	}
	// Neubewertung blockierter, noch nicht begonnener Aufträge (höhere Priorität zuerst)
	now := s.now()
	jobs, _ := s.St.ListJobs(ctx, JobFilter{States: []string{StBlocked}, Limit: 200})
	sort.SliceStable(jobs, func(i, k int) bool { return jobs[i].Priority > jobs[k].Priority })
	for _, j := range jobs {
		if j.PlannedEnd.After(now) {
			_, _, _ = s.Admit(ctx, j.ID)
		}
	}
}

// ---- Einzelaufträge ------------------------------------------------------------------------------------------------

// AdHocInput: einmalige Aufnahme ohne Zeitplan.
type AdHocInput struct {
	Name       string         `json:"name"`
	Source     Source         `json:"source"`
	Start      *time.Time     `json:"start"` // leer = jetzt
	DurationS  int64          `json:"durationS"`
	ProfileID  string         `json:"profileId"`
	Storage    Storage        `json:"storage"`
	Metadata   map[string]any `json:"metadata"`
	Priority   *int           `json:"priority"`
	Late       LatePolicy     `json:"late"`
	Retry      RetryPolicy    `json:"retry"`
	HostPref   string         `json:"hostPref"`
	Owner      string         `json:"owner"`
	OwnerGroup string         `json:"ownerGroup"`
}

func (s *Service) CreateAdHoc(ctx context.Context, in AdHocInput, actor string) (Job, Decision, error) {
	start := s.now().Add(5 * time.Second)
	if in.Start != nil {
		start = in.Start.UTC()
	}
	si := ScheduleInput{Name: in.Name, Source: in.Source, Spec: Spec{TZ: "UTC", StartLocal: start.Format(localLayout), DurationS: in.DurationS}, ProfileID: in.ProfileID, Storage: in.Storage, Priority: in.Priority, Late: in.Late, Retry: in.Retry, HostPref: in.HostPref, Owner: in.Owner, OwnerGroup: in.OwnerGroup}
	if err := s.validate(&si); err != nil {
		return Job{}, Decision{}, err
	}
	sc := s.toSchedule(si, actor)
	j, _, err := s.St.CreateJob(ctx, Job{Key: "adhoc|" + newID(), Name: sc.Name, PlannedStart: start.Truncate(time.Second), PlannedEnd: start.Truncate(time.Second).Add(time.Duration(in.DurationS) * time.Second), TZ: "UTC",
		MaxAttempts: sc.Retry.MaxAttempts, Priority: sc.Priority, Source: in.Source, ProfileID: in.ProfileID, HostPref: in.HostPref, Storage: in.Storage, Metadata: in.Metadata, Late: sc.Late, CreatedBy: actor, Owner: sc.Owner, OwnerGroup: sc.OwnerGroup})
	if err != nil {
		return j, Decision{}, err
	}
	d, j, err := s.Admit(ctx, j.ID)
	s.audit(actor, j.ID, "adhoc_created", map[string]any{"admit": d.Admit})
	return j, d, err
}

// CancelJob bricht einen Auftrag ab. Laufende Aufnahmen nur mit abort=true (ausdrücklich); die Teilaufnahme wird dann finalisiert und
// als Asset registriert, nicht verworfen.
func (s *Service) CancelJob(ctx context.Context, id, actor string, abort bool, expectedRev int) (Job, error) {
	j, err := s.St.GetJob(ctx, id)
	if err != nil {
		return j, err
	}
	switch j.State {
	case StBlocked, StScheduled, StWaiting:
		out, err := s.St.Mutate(ctx, id, expectedRev, "abgebrochen durch "+actor, func(x *Job) (map[string]any, error) {
			x.State = StCancelled
			return nil, nil
		})
		if err == nil {
			s.teardownInstance(ctx, j)
			s.audit(actor, id, "cancelled", nil)
		}
		return out, err
	case StStarting, StRecording:
		if !abort {
			return j, fmt.Errorf("%w: Aufnahme läuft — nur mit ausdrücklichem Abbruch (abort) beendbar", ErrState)
		}
		out, err := s.St.Mutate(ctx, id, expectedRev, "Abbruch durch "+actor+" (Teilaufnahme wird gesichert)", func(x *Job) (map[string]any, error) {
			x.Error = "abgebrochen"
			// Ende auf „jetzt“ ziehen: der Ablauf stoppt die Aufnahme im nächsten Schritt und finalisiert
			now := s.now()
			if now.Before(x.PlannedEnd) {
				x.PlannedEnd = now
			}
			return nil, nil
		})
		if err == nil {
			s.audit(actor, id, "abort_requested", nil)
		}
		return out, err
	}
	return j, fmt.Errorf("%w: Zustand %s", ErrState, j.State)
}

// RescheduleJob verschiebt einen noch nicht gestarteten Auftrag (Start und/oder Dauer) und lässt ihn neu zu.
func (s *Service) RescheduleJob(ctx context.Context, id, actor string, start time.Time, durationS int64, expectedRev int) (Decision, Job, error) {
	if durationS < 1 || durationS > 7*24*3600 {
		return Decision{}, Job{}, &ValidationError{Problems: []string{"Dauer muss zwischen 1 s und 7 Tagen liegen"}}
	}
	_, err := s.St.Mutate(ctx, id, expectedRev, "verschoben durch "+actor, func(x *Job) (map[string]any, error) {
		if x.State != StBlocked && x.State != StScheduled && x.State != StWaiting {
			return nil, fmt.Errorf("%w: Zustand %s", ErrState, x.State)
		}
		x.PlannedStart, x.PlannedEnd = start.UTC(), start.UTC().Add(time.Duration(durationS)*time.Second)
		x.Shifted, x.Ambiguous = false, false
		if x.State != StBlocked && x.State != StScheduled {
			return map[string]any{"start": x.PlannedStart, "durationS": durationS}, nil
		}
		return map[string]any{"start": x.PlannedStart, "durationS": durationS}, nil
	})
	if err != nil {
		return Decision{}, Job{}, err
	}
	// Reservierung neu berechnen (gibt die alte frei)
	s.audit(actor, id, "rescheduled", map[string]any{"start": start})
	return s.Admit(ctx, id)
}

// ---- Dateinamen ---------------------------------------------------------------------------------------------------

func (s *Service) fileRel(j Job, attempt int, ext string) string {
	tpl := j.Storage.FileTemplate
	if tpl == "" {
		tpl = "{name}_{date}_{time}"
	}
	ps := j.PlannedStart.UTC()
	name := safeName.ReplaceAllString(j.Name, "_")
	r := strings.NewReplacer("{name}", name, "{date}", ps.Format("20060102"), "{time}", ps.Format("150405"), "{job}", j.ID[:min(8, len(j.ID))])
	f := r.Replace(tpl)
	f = safeName.ReplaceAllString(f, "_")
	if attempt > 1 {
		f += fmt.Sprintf("_a%d", attempt)
	}
	f += ext
	if d := strings.Trim(j.Storage.Dir, "/"); d != "" {
		return filepath.ToSlash(filepath.Join(safeDir(d), f))
	}
	return f
}

func safeDir(d string) string {
	parts := strings.Split(filepath.ToSlash(filepath.Clean(d)), "/")
	var out []string
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			continue
		}
		out = append(out, safeName.ReplaceAllString(p, "_"))
	}
	return strings.Join(out, "/")
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		return -1
	}
	return st.Size()
}

package ingest

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// simRuntime simuliert Launcher/Registry/Rekorder: schreibt beim Stoppen eine Datei, kann Fehler einspielen.
type simRuntime struct {
	mu          sync.Mutex
	dir         string
	instances   map[string]*simInst
	prepareErr  error
	sourceDown  bool
	connectErr  error
	startErr    error
	dieOnStatus map[string]bool // Instanz-ID → Status meldet Fehler
	prepares    int
	teardowns   []string
	recordings  map[string]string // Instanz → Datei
}

type simInst struct {
	id, job, host string
	recording     bool
	file          string
}

func newSim(dir string) *simRuntime {
	return &simRuntime{dir: dir, instances: map[string]*simInst{}, dieOnStatus: map[string]bool{}, recordings: map[string]string{}}
}

func (r *simRuntime) Prepare(ctx context.Context, jobID, hostID, label, mediaDir string) (Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.prepareErr != nil {
		return Session{}, r.prepareErr
	}
	for _, in := range r.instances { // idempotent: vorhandene Instanz des Auftrags wiederverwenden
		if in.job == jobID {
			return Session{InstanceID: in.id, HostID: hostID}, nil
		}
	}
	r.prepares++
	id := fmt.Sprintf("inst-%s-%d", jobID[:6], r.prepares)
	r.instances[id] = &simInst{id: id, job: jobID, host: hostID}
	return Session{InstanceID: id, HostID: hostID}, nil
}

func (r *simRuntime) Adopt(ctx context.Context, id string) (Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.instances[id]
	return Session{InstanceID: id}, ok
}

func (r *simRuntime) ResolveSource(ctx context.Context, src Source) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sourceDown {
		return ErrSourceUnavailable
	}
	return nil
}

func (r *simRuntime) Connect(ctx context.Context, s Session, src Source) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connectErr
}

func (r *simRuntime) StartRecording(ctx context.Context, s Session, fileRel, mca string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.startErr != nil {
		return r.startErr
	}
	in := r.instances[s.InstanceID]
	if in == nil {
		return errors.New("Instanz unbekannt")
	}
	in.recording, in.file = true, filepath.Join(r.dir, filepath.FromSlash(fileRel))
	_ = os.MkdirAll(filepath.Dir(in.file), 0o755)
	// Rekorder schreibt sofort
	_ = os.WriteFile(in.file, []byte("DATA-"+fileRel), 0o644)
	return nil
}

func (r *simRuntime) Status(ctx context.Context, s Session) (string, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	in := r.instances[s.InstanceID]
	if in == nil {
		return "", 0, errors.New("Instanz verschwunden")
	}
	if r.dieOnStatus[s.InstanceID] {
		return "error", 0, nil
	}
	if in.recording {
		return "recording", 1000, nil
	}
	return "idle", 0, nil
}

func (r *simRuntime) StopRecording(ctx context.Context, s Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if in := r.instances[s.InstanceID]; in != nil {
		in.recording = false
	}
	return nil
}

func (r *simRuntime) Teardown(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.instances, id)
	r.teardowns = append(r.teardowns, id)
	return nil
}

func (r *simRuntime) Instances(ctx context.Context) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for id := range r.instances {
		out = append(out, id)
	}
	return out
}

func (r *simRuntime) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.instances)
}

type ienv struct {
	svc   *Service
	rt    *simRuntime
	dir   string
	clock *time.Time
	cfg   *Config
}

type nopAudit struct{}

func (nopAudit) Log(actor, objectType, objectID, action string, details map[string]any) {}

func newIEnv(t *testing.T, mut func(*Config)) *ienv {
	t.Helper()
	db := dbtest.Open(t)
	reg := module.NewRegistry()
	if err := reg.Register(&Module{}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// Tests teilen sich die Datenbank: Reste früherer Tests entfernen
	for _, tbl := range []string{"ingest_reservations", "ingest_job_events", "ingest_jobs", "ingest_schedules", "ingest_profile_stats"} {
		if _, err := db.Exec("DELETE FROM " + tbl); err != nil {
			t.Fatal(err)
		}
	}
	dir := t.TempDir()
	cfg := DefaultConfig()
	cfg.MediaDir = dir
	cfg.LeadTimeS = 30
	cfg.DefaultBudget.Hard[ResRecorders] = 2
	if mut != nil {
		mut(&cfg)
	}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	e := &ienv{rt: newSim(dir), dir: dir, clock: &clock, cfg: &cfg}
	e.svc = &Service{St: NewStore(db), Cfg: func() Config { return *e.cfg }, Runtime: e.rt, Assets: asset.NewStore(db), Audit: nopAudit{}, Now: func() time.Time { return *e.clock },
		Hosts: func(ctx context.Context) []HostInfo { return []HostInfo{{ID: "local", Label: "lokal", Online: true}} }}
	return e
}

func (e *ienv) at(min int) {
	*e.clock = time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC).Add(time.Duration(min) * time.Minute)
}
func (e *ienv) atSec(s int) {
	*e.clock = time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC).Add(time.Duration(s) * time.Second)
}

func (e *ienv) adhoc(t *testing.T, startMin, durMin int, mut func(*AdHocInput)) Job {
	t.Helper()
	st := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC).Add(time.Duration(startMin) * time.Minute)
	in := AdHocInput{Name: "Test", Source: Source{InstanceID: "src1", Label: "Kamera 1"}, Start: &st, DurationS: int64(durMin * 60), ProfileID: "mxf-h264"}
	if mut != nil {
		mut(&in)
	}
	j, _, err := e.svc.CreateAdHoc(context.Background(), in, "tester")
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func (e *ienv) job(t *testing.T, id string) Job {
	t.Helper()
	j, err := e.svc.St.GetJob(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestFullLifecycleAndAssetRegistration(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	j := e.adhoc(t, 10, 20, nil)
	if j.State != StScheduled || j.HostID != "local" {
		t.Fatalf("admitted job: %+v", j)
	}
	e.at(0)
	e.svc.Step(ctx)
	if e.job(t, j.ID).State != StScheduled || e.rt.count() != 0 {
		t.Fatal("too early: nothing may start before the lead time")
	}
	e.atSec(10*60 - 20) // 20 s vor dem Start, Vorwärmzeit 30 s
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	if g.State != StStarting || g.InstanceID == "" || e.rt.count() != 1 {
		t.Fatalf("warm-up: %+v", g)
	}
	if _, err := os.Stat(g.FilePath); err == nil {
		t.Fatal("recording must not start before the planned start")
	}
	e.at(10)
	e.svc.Step(ctx)
	g = e.job(t, j.ID)
	if g.State != StRecording || g.DeviationMs == nil || *g.DeviationMs != 0 || g.ActualStart == nil {
		t.Fatalf("recording: %+v", g)
	}
	e.at(20)
	e.svc.Step(ctx)
	if e.job(t, j.ID).State != StRecording {
		t.Fatal("still recording before the end")
	}
	e.at(30)
	e.svc.Step(ctx) // Stopp → finalizing
	e.svc.Step(ctx) // finalisieren → completed
	g = e.job(t, j.ID)
	if g.State != StCompleted || g.AssetID == "" || e.rt.count() != 0 {
		t.Fatalf("completed: %+v instances=%d", g, e.rt.count())
	}
	// Asset: Rohdatei registriert, veröffentlicht, Status registered
	a, err := e.svc.Assets.GetAsset(g.AssetID)
	if err != nil || a.Status != asset.StatusRegistered || a.CurrentVersionID == "" {
		t.Fatalf("asset: %v %+v", err, a)
	}
	reps, _ := e.svc.Assets.ListRepresentations(a.CurrentVersionID)
	if len(reps) != 1 || reps[0].Storage.URI != g.FilePath || reps[0].Type != "recorded" {
		t.Fatalf("representations: %+v", reps)
	}
	// Reservierungen freigegeben
	b, _ := e.svc.St.Booked(ctx, time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC))
	if len(b) != 0 {
		t.Fatalf("reservations leaked: %+v", b)
	}
	ev, _ := e.svc.St.Events(ctx, j.ID)
	var states []string
	for _, x := range ev {
		if x.ToState != "" && x.ToState != x.FromState { // Meldungen ohne Zustandswechsel sind nur Information
			states = append(states, x.ToState)
		}
	}
	want := []string{StBlocked, StScheduled, StStarting, StRecording, StFinalizing, StCompleted}
	if fmt.Sprint(states) != fmt.Sprint(want) {
		t.Fatalf("state history %v, want %v", states, want)
	}
}

func TestRestartMidRecordingAdoptsInsteadOfDuplicating(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	j := e.adhoc(t, 10, 20, nil)
	e.at(10)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	if g.State != StRecording {
		t.Fatalf("%+v", g)
	}
	inst, prepares := g.InstanceID, e.rt.prepares
	// „Neustart“: neuer Service über derselben DB und derselben (weiterlaufenden) Laufzeit
	e2 := &Service{St: e.svc.St, Cfg: e.svc.Cfg, Runtime: e.rt, Assets: e.svc.Assets, Audit: nopAudit{}, Now: e.svc.Now, Hosts: e.svc.Hosts}
	e2.Reconcile(ctx)
	for i := 0; i < 3; i++ {
		e.at(12 + i)
		e2.Step(ctx)
	}
	g = e.job(t, j.ID)
	if g.State != StRecording || g.InstanceID != inst || e.rt.prepares != prepares || e.rt.count() != 1 {
		t.Fatalf("restart must adopt the running recording: %+v prepares=%d", g, e.rt.prepares)
	}
	e.at(30)
	e2.Step(ctx)
	e2.Step(ctx)
	if g = e.job(t, j.ID); g.State != StCompleted {
		t.Fatalf("%+v", g)
	}
}

func TestOrphanedRecorderIsReaped(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	e.rt.instances["ghost"] = &simInst{id: "ghost", job: "none"}
	e.svc.Reconcile(ctx)
	if e.rt.count() != 0 {
		t.Fatal("orphan recorder must be torn down")
	}
}

func TestDuplicateMaterializationCreatesOneJob(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	e.cfg.HorizonHours = 36
	sc, err := e.svc.CreateSchedule(ctx, ScheduleInput{Name: "Tagesschau", Source: Source{InstanceID: "src1"}, ProfileID: "mxf-h264",
		Spec: Spec{TZ: "Europe/Berlin", StartLocal: "2026-10-20T20:00", DurationS: 900, Rec: Recurrence{Freq: "daily"}}}, "tester")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		e.svc.MaterializeAll(ctx)
		if _, err := e.svc.Materialize(ctx, sc); err != nil {
			t.Fatal(err)
		}
	}
	jobs, _ := e.svc.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID})
	if len(jobs) != 2 { // 20.10. und 21.10. je 20:00 CEST innerhalb von 36 h ab 10:00 UTC
		t.Fatalf("%d jobs: %+v", len(jobs), jobs)
	}
	var keys = map[string]bool{}
	for _, j := range jobs {
		keys[j.Key] = true
		if j.State != StScheduled {
			t.Errorf("job %s = %s", j.ID, j.State)
		}
	}
	if len(keys) != 2 {
		t.Fatal("idempotency keys must be unique per occurrence")
	}
}

func TestScheduleEditReplacesFutureButNeverTouchesRunning(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	e.cfg.HorizonHours = 72
	sc, _ := e.svc.CreateSchedule(ctx, ScheduleInput{Name: "S", Source: Source{InstanceID: "src1"}, ProfileID: "mxf-h264",
		Spec: Spec{TZ: "UTC", StartLocal: "2026-10-20T10:00", DurationS: 3600, Rec: Recurrence{Freq: "daily"}}}, "tester")
	jobs, _ := e.svc.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID})
	var first Job
	for _, j := range jobs {
		if j.PlannedStart.Day() == 20 {
			first = j
		}
	}
	e.at(0)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	if g := e.job(t, first.ID); g.State != StRecording {
		t.Fatalf("%+v", g)
	}
	// Zeitplan auf 11:00 ändern
	n := ScheduleInput{Name: "S", Source: Source{InstanceID: "src1"}, ProfileID: "mxf-h264", Spec: Spec{TZ: "UTC", StartLocal: "2026-10-20T11:00", DurationS: 3600, Rec: Recurrence{Freq: "daily"}}}
	if _, err := e.svc.UpdateSchedule(ctx, sc.ID, n, sc.Revision, "tester"); err != nil {
		t.Fatal(err)
	}
	if g := e.job(t, first.ID); g.State != StRecording {
		t.Fatalf("a running recording must never be touched by an edit: %+v", g)
	}
	var cancelled, scheduled int
	all, _ := e.svc.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID})
	for _, j := range all {
		switch j.State {
		case StCancelled:
			cancelled++
		case StScheduled:
			scheduled++
		}
	}
	if cancelled < 2 || scheduled < 2 {
		t.Fatalf("future jobs must be replaced: cancelled=%d scheduled=%d", cancelled, scheduled)
	}
	// Konflikt: veraltete Revision
	if _, err := e.svc.UpdateSchedule(ctx, sc.ID, n, sc.Revision, "x"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision = %v", err)
	}
}

func TestAdmissionBlocksAndRecoversWhenCapacityFrees(t *testing.T) {
	e := newIEnv(t, func(c *Config) { c.DefaultBudget.Hard[ResRecorders] = 1 })
	ctx := context.Background()
	a := e.adhoc(t, 10, 60, nil)
	b := e.adhoc(t, 30, 30, func(in *AdHocInput) { in.Source = Source{InstanceID: "src2"} })
	if a.State != StScheduled || b.State != StBlocked {
		t.Fatalf("a=%s b=%s", a.State, b.State)
	}
	if len(b.Verdicts) == 0 || b.Verdicts[0].Kind != VTempOccupied || b.EarliestStart == nil || !b.EarliestStart.Equal(a.PlannedEnd) {
		t.Fatalf("blocked job must explain itself: %+v earliest=%v", b.Verdicts, b.EarliestStart)
	}
	// Auftrag a wird abgebrochen → b wird bei der Neubewertung zugelassen
	if _, err := e.svc.CancelJob(ctx, a.ID, "tester", false, -1); err != nil {
		t.Fatal(err)
	}
	e.svc.MaterializeAll(ctx)
	if g := e.job(t, b.ID); g.State != StScheduled {
		t.Fatalf("freed capacity must admit the blocked job: %+v", g)
	}
}

func TestConcurrentAdmissionNeverOversubscribes(t *testing.T) {
	e := newIEnv(t, func(c *Config) { c.DefaultBudget.Hard[ResRecorders] = 3 })
	ctx := context.Background()
	var jobs []Job
	for i := 0; i < 10; i++ {
		st := time.Date(2026, 10, 20, 11, 0, 0, 0, time.UTC)
		j, _, err := e.svc.St.CreateJob(ctx, Job{Key: fmt.Sprintf("race|%d", i), Name: "R", PlannedStart: st, PlannedEnd: st.Add(time.Hour), TZ: "UTC", MaxAttempts: 1, Priority: 5,
			Source: Source{InstanceID: fmt.Sprintf("cam%d", i)}, ProfileID: "mxf-h264", Late: LatePolicy{Mode: "wait"}})
		if err != nil {
			t.Fatal(err)
		}
		jobs = append(jobs, j)
	}
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if _, _, err := e.svc.Admit(ctx, id); err != nil {
				t.Errorf("admit: %v", err)
			}
		}(j.ID)
	}
	wg.Wait()
	adm := 0
	for _, j := range jobs {
		if e.job(t, j.ID).State == StScheduled {
			adm++
		}
	}
	if adm != 3 {
		t.Fatalf("exactly 3 recorder slots → exactly 3 admitted, got %d", adm)
	}
	booked, _ := e.svc.St.Booked(ctx, e.svc.now())
	if len(booked) != 3 {
		t.Fatalf("booked windows = %d", len(booked))
	}
}

func TestLatePolicyWaitDelayFail(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		mode     string
		maxDelay int
		at       int // Sekunden nach Start, zu denen geprüft wird
		want     string
	}{
		{"wait", 0, 300, StWaiting},
		{"delay", 120, 60, StWaiting},
		{"delay", 120, 200, StFailed},
		{"fail", 0, 5, StFailed},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.mode, tc.at), func(t *testing.T) {
			e := newIEnv(t, nil)
			j := e.adhoc(t, 10, 20, func(in *AdHocInput) { in.Late = LatePolicy{Mode: tc.mode, MaxDelayS: tc.maxDelay} })
			e.rt.sourceDown = true
			e.atSec(10*60 - 20)
			e.svc.Step(ctx)
			if g := e.job(t, j.ID); g.State != StStarting {
				t.Fatalf("before the start the missing source is only noted: %+v", g)
			}
			e.atSec(10*60 + tc.at)
			e.svc.Step(ctx)
			g := e.job(t, j.ID)
			if g.State != tc.want {
				t.Fatalf("%+v", g)
			}
			if g.State == StFailed && (g.FailedStage != "source" || g.Error == "") {
				t.Fatalf("failure must say why: %+v", g)
			}
			// Quelle kommt später: wait/delay → Aufnahme beginnt, endet aber zur geplanten Zeit
			if tc.want == StWaiting {
				e.rt.sourceDown = false
				e.svc.Step(ctx)
				e.svc.Step(ctx)
				g = e.job(t, j.ID)
				if g.State != StRecording || g.DeviationMs == nil || *g.DeviationMs < int64(tc.at)*1000 {
					t.Fatalf("late start must be recorded as deviation: %+v", g)
				}
			}
		})
	}
}

func TestRecorderCrashSavesPartialAndRetriesRestOfWindow(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	j := e.adhoc(t, 10, 20, func(in *AdHocInput) { in.Retry = RetryPolicy{MaxAttempts: 2} })
	e.at(10)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	first := g.FilePath
	e.rt.dieOnStatus[g.InstanceID] = true
	e.at(14)
	e.svc.Step(ctx)
	g = e.job(t, j.ID)
	if g.State != StStarting || g.Attempt != 2 || g.AssetID == "" {
		t.Fatalf("after the crash: %+v", g)
	}
	if fileSize(first) <= 0 {
		t.Fatal("the partial recording must be preserved")
	}
	partial, _ := e.svc.Assets.GetAsset(g.AssetID)
	if partial.Status != asset.StatusRegistered {
		t.Fatalf("partial asset must be registered (reviewable): %+v", partial)
	}
	e.svc.Step(ctx) // Neuer Rekorder, nimmt in neue Datei auf
	g = e.job(t, j.ID)
	if g.State != StRecording || g.FilePath == first {
		t.Fatalf("second attempt must write a new file: %+v", g)
	}
	e.at(30)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g = e.job(t, j.ID)
	if g.State != StCompleted || e.rt.count() != 0 {
		t.Fatalf("%+v", g)
	}
	// ohne Wiederholung: fehlgeschlagen, Teilaufnahme bleibt als Asset am Auftrag
	j2 := e.adhoc(t, 40, 20, func(in *AdHocInput) { in.Retry = RetryPolicy{MaxAttempts: 1}; in.Source = Source{InstanceID: "src2"} })
	e.at(40)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g2 := e.job(t, j2.ID)
	e.rt.dieOnStatus[g2.InstanceID] = true
	e.at(45)
	e.svc.Step(ctx)
	g2 = e.job(t, j2.ID)
	if g2.State != StFailed || g2.FailedStage != "recording" || g2.AssetID == "" {
		t.Fatalf("failed job keeps the partial asset: %+v", g2)
	}
	b, _ := e.svc.St.Booked(ctx, time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC))
	if len(b) != 0 {
		t.Fatalf("reservations must be released after failure: %+v", b)
	}
}

func TestConversionFailureNeverLosesTheRecording(t *testing.T) {
	e := newIEnv(t, func(c *Config) {
		p := c.Profiles["mxf-h264"]
		p.Convert = &ConvertStep{Ext: ".mp4", Args: []string{"-c:v", "libx264"}}
		c.Profiles["mxf-h264"] = p
	})
	e.svc.FFmpeg = "/bin/false" // Konvertierung scheitert immer
	ctx := context.Background()
	j := e.adhoc(t, 10, 20, nil)
	e.at(10)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	e.at(30)
	e.svc.Step(ctx)
	e.svc.Step(ctx) // finalizing → processing
	e.svc.Step(ctx) // processing → failed
	g := e.job(t, j.ID)
	if g.State != StFailed || g.FailedStage != "processing" || g.AssetID == "" {
		t.Fatalf("%+v", g)
	}
	a, err := e.svc.Assets.GetAsset(g.AssetID)
	if err != nil || a.Status != asset.StatusRegistered || fileSize(g.FilePath) <= 0 {
		t.Fatalf("the raw recording must stay available and registered: %v %+v", err, a)
	}
}

func TestAbortKeepsPartialRecordingAndRequiresExplicitRequest(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	j := e.adhoc(t, 10, 60, nil)
	e.at(10)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	e.at(20)
	if _, err := e.svc.CancelJob(ctx, j.ID, "bob", false, -1); !errors.Is(err, ErrState) {
		t.Fatalf("running recordings are never cancelled implicitly: %v", err)
	}
	if _, err := e.svc.CancelJob(ctx, j.ID, "bob", true, -1); err != nil {
		t.Fatal(err)
	}
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	if g.State != StCancelled || g.AssetID == "" || fileSize(g.FilePath) <= 0 {
		t.Fatalf("abort must keep the partial recording as an asset: %+v", g)
	}
}

func TestMissedWindowFailsVisibly(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	j := e.adhoc(t, 10, 20, nil)
	e.at(60) // Orchestrator war aus: das ganze Fenster ist vorbei
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	if g.State != StFailed || g.FailedStage != "schedule" {
		t.Fatalf("%+v", g)
	}
}

func TestRescheduleReadmits(t *testing.T) {
	e := newIEnv(t, func(c *Config) { c.DefaultBudget.Hard[ResRecorders] = 1 })
	ctx := context.Background()
	a := e.adhoc(t, 10, 30, nil)
	b := e.adhoc(t, 20, 10, func(in *AdHocInput) { in.Source = Source{InstanceID: "src2"} })
	if b.State != StBlocked {
		t.Fatal("setup")
	}
	d, g, err := e.svc.RescheduleJob(ctx, b.ID, "tester", a.PlannedEnd, 600, -1)
	if err != nil || !d.Admit || g.State != StScheduled || !g.PlannedStart.Equal(a.PlannedEnd) {
		t.Fatalf("%v %+v %+v", err, d, g)
	}
}

// Gemessene Werte fließen in die nächste Planung (Messung vor Konfiguration vor Standard, Herkunft je Wert sichtbar).
func TestMeasuredStatsReplaceDefaultsAfterARecording(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	if err := e.svc.St.RecordStats(ctx, "mxf-h264", 2e6, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.St.RecordStats(ctx, "mxf-h264", 4e6, 0, 0); err != nil {
		t.Fatal(err)
	}
	st, err := e.svc.St.Stats(ctx, "mxf-h264")
	if err != nil || st == nil || st.Samples != 2 || st.BytesPerS != 3e6 {
		t.Fatalf("stats: %v %+v", err, st)
	}
	d := EffectiveDemand(e.cfg.Profiles["mxf-h264"], st, 600)
	if d.Origin[ResDiskMBps] != OriginMeasured || math.Abs(d.Amount[ResDiskMBps]-3.6) > 1e-9 || d.Origin[ResCPU] != OriginDefault {
		t.Fatalf("%+v", d)
	}
	// End-to-End: eine echte Aufnahme erzeugt eine Messung
	j := e.adhoc(t, 10, 20, nil)
	e.at(10)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	e.at(30)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	if g := e.job(t, j.ID); g.State != StCompleted {
		t.Fatalf("%+v", g)
	}
	st, _ = e.svc.St.Stats(ctx, "mxf-h264")
	if st.Samples != 3 {
		t.Fatalf("a completed recording must add a sample: %+v", st)
	}
}

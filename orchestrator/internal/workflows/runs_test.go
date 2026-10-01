package workflows

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRun struct {
	id, name, source, reason string
	closed                   bool
	at                       time.Time
}

type fakeRecorder struct {
	mu   sync.Mutex
	runs []*fakeRun
}

func (f *fakeRecorder) Open(id, name, source string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.runs {
		if r.id == id && !r.closed {
			r.closed, r.reason = true, RunEndUnknown
		}
	}
	f.runs = append(f.runs, &fakeRun{id: id, name: name, source: source, at: at})
	return nil
}

func (f *fakeRecorder) Close(id, reason string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.runs {
		if r.id == id && !r.closed {
			r.closed, r.reason = true, reason
		}
	}
	return nil
}

func (f *fakeRecorder) OpenWorkflowIDs() (map[string]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for _, r := range f.runs {
		if !r.closed {
			out[r.id] = true
		}
	}
	return out, nil
}

func (f *fakeRecorder) last(t *testing.T) fakeRun {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.runs) == 0 {
		t.Fatal("kein Lauf aufgezeichnet")
	}
	return *f.runs[len(f.runs)-1]
}

func waitRunClosed(t *testing.T, f *fakeRecorder) fakeRun {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if r := f.last(t); r.closed {
			return r
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Lauf wurde nicht beendet: %+v", f.last(t))
	return fakeRun{}
}

func adoptedRunning(t *testing.T, svc *Service) Workflow {
	t.Helper()
	wf, err := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}},
		map[string]RoleRuntime{"src": {InstanceID: "inst-src", NodeID: "node-src"}}, "")
	if err != nil {
		t.Fatal(err)
	}
	return wf
}

func TestRunHistoryManualStop(t *testing.T) {
	rec := &fakeRecorder{}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	svc.SetRunRecorder(rec)
	wf := adoptedRunning(t, svc)
	if r := rec.last(t); r.source != RunSourceAdopted || r.closed || r.name != "wf" {
		t.Fatalf("beim Übernehmen laufender Instanzen muss ein Lauf öffnen: %+v", r)
	}
	if err := svc.Stop(context.Background(), wf.ID, false); err != nil {
		t.Fatal(err)
	}
	if r := waitRunClosed(t, rec); r.reason != RunEndManual {
		t.Errorf("Stop ohne Markierung = %q, want manual", r.reason)
	}
}

func TestRunHistoryScheduledStop(t *testing.T) {
	rec := &fakeRecorder{}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	svc.SetRunRecorder(rec)
	wf := adoptedRunning(t, svc)
	if err := svc.Stop(WithTrigger(context.Background(), RunSourceSchedule), wf.ID, true); err != nil {
		t.Fatal(err)
	}
	if r := waitRunClosed(t, rec); r.reason != RunEndScheduled {
		t.Errorf("Zeitplan-Stop = %q, want scheduled", r.reason)
	}
}

func TestRunHistoryStartSourceAndFailure(t *testing.T) {
	rec := &fakeRecorder{}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{startErr: errors.New("boom")})
	svc.SetRunRecorder(rec)
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil, "")
	if err := svc.Start(WithTrigger(context.Background(), RunSourceSchedule), wf.ID); err != nil {
		t.Fatal(err)
	}
	r := waitRunClosed(t, rec)
	if r.source != RunSourceSchedule || r.reason != RunEndFailed {
		t.Errorf("Start per Zeitplan, dann Fehler = %+v", r)
	}
}

func TestReconcileRuns(t *testing.T) {
	rec := &fakeRecorder{}
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	svc.SetRunRecorder(rec)

	stoppedWf, _ := svc.Create("stopped", Definition{Roles: []Role{{Name: "a", NodeType: "omp-source"}}}, nil, "")
	runningWf, _ := svc.Create("running", Definition{Roles: []Role{{Name: "a", NodeType: "omp-source"}}}, nil, "")
	r := runningWf
	r.Status = StatusStarted
	_ = store.Put(r)

	// Orchestrator war aus: für den gestoppten Workflow blieb ein Lauf offen,
	// für den laufenden gibt es (noch) keinen; ein gelöschter hatte einen offenen.
	_ = rec.Open(stoppedWf.ID, "stopped", RunSourceManual, time.Now().Add(-time.Hour))
	_ = rec.Open("geloescht", "weg", RunSourceManual, time.Now().Add(-time.Hour))
	svc.ReconcileRuns()

	open, _ := rec.OpenWorkflowIDs()
	if len(open) != 1 || !open[runningWf.ID] {
		t.Errorf("nach Abgleich nur der laufende Workflow offen, got %v", open)
	}
	for _, run := range rec.runs {
		if (run.id == stoppedWf.ID || run.id == "geloescht") && run.reason != RunEndUnknown {
			t.Errorf("%s: Ende %q, want unknown", run.id, run.reason)
		}
		if run.id == runningWf.ID && run.source != RunSourceRestored {
			t.Errorf("laufender Workflow ohne Lauf: Quelle %q, want restored", run.source)
		}
	}
}

func TestRunStorePostgres(t *testing.T) {
	database := testDB(t)
	s := NewRunStore(database)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM workflow_runs`) })
	_, _ = database.Exec(`DELETE FROM workflow_runs`)

	base := time.Now().Add(-10 * time.Hour).Truncate(time.Second)
	if err := s.Open("w1", "Show", RunSourceSchedule, base); err != nil {
		t.Fatal(err)
	}
	// zweiter Open ohne Close: der alte Lauf endet als "unknown", es bleibt genau einer offen
	if err := s.Open("w1", "Show", RunSourceManual, base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close("w1", RunEndManual, base.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Open("w2", "Offen", RunSourceManual, base.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}

	got, err := s.List(base.Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil || len(got) != 3 {
		t.Fatalf("List = %d %v", len(got), err)
	}
	if got[0].EndReason != RunEndUnknown || got[1].EndReason != RunEndManual || got[1].EndedAt == nil || got[2].EndedAt != nil {
		t.Errorf("Läufe = %+v", got)
	}
	// Zeitraum davor: nichts; Zeitraum nur um den offenen Lauf: dieser (offene zählen bis "jetzt")
	if got, _ := s.List(base.Add(-5*time.Hour), base.Add(-4*time.Hour)); len(got) != 0 {
		t.Errorf("Zeitraum vor allem = %+v", got)
	}
	if got, _ := s.List(time.Now().Add(-time.Minute), time.Now()); len(got) != 1 || got[0].WorkflowID != "w2" {
		t.Errorf("Zeitraum jetzt = %+v", got)
	}
	if since, err := s.TrackingSince(); err != nil || !since.Equal(base) {
		t.Errorf("TrackingSince = %v %v, want %v", since, err, base)
	}

	// Aufbewahrung: nur beendete Läufe, die länger als N Tage zurückliegen, werden gelöscht
	if _, err := database.Exec(`INSERT INTO workflow_runs (workflow_id, workflow_name, started_at, ended_at, start_source, end_reason)
		VALUES ('alt', 'Alt', now() - interval '41 days', now() - interval '40 days', 'manual', 'manual')`); err != nil {
		t.Fatal(err)
	}
	// ein uralter, aber noch OFFENER Lauf darf nie gelöscht werden
	if _, err := database.Exec(`INSERT INTO workflow_runs (workflow_id, workflow_name, started_at, start_source)
		VALUES ('uralt-offen', 'Offen', now() - interval '90 days', 'manual')`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.PurgeOlderThan(30); err != nil || n != 1 {
		t.Errorf("Purge(30) gelöscht %d %v, want 1 (nur der beendete alte Lauf)", n, err)
	}
	if n, _ := s.PurgeOlderThan(0); n != 0 {
		t.Errorf("Purge(0) muss deaktiviert sein, löschte %d", n)
	}
	var left int
	_ = database.QueryRow(`SELECT count(*) FROM workflow_runs`).Scan(&left)
	if left != 4 { // w1 (2) + w2 + uralt-offen
		t.Errorf("übrig %d, want 4", left)
	}
}

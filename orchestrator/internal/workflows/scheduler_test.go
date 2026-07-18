package workflows

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type schedulerAction struct {
	action  string // "start" | "stop"
	id      string
	confirm bool
}

// fakeSchedulerLauncher ist ein Test-Double für SchedulerLauncher —
// hält Workflows in einer Map (wie fakeStore), zeichnet Start/Stop-
// Aufrufe auf und übernimmt persistSchedule() wie ein echter Store.
type fakeSchedulerLauncher struct {
	mu       sync.Mutex
	wfs      map[string]Workflow
	actions  []schedulerAction
	startErr error
	stopErr  error
}

func newFakeSchedulerLauncher(wfs ...Workflow) *fakeSchedulerLauncher {
	f := &fakeSchedulerLauncher{wfs: map[string]Workflow{}}
	for _, wf := range wfs {
		f.wfs[wf.ID] = wf
	}
	return f
}

func (f *fakeSchedulerLauncher) List() ([]Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Workflow, 0, len(f.wfs))
	for _, wf := range f.wfs {
		out = append(out, wf)
	}
	return out, nil
}

func (f *fakeSchedulerLauncher) Start(ctx context.Context, id string) error {
	f.mu.Lock()
	f.actions = append(f.actions, schedulerAction{action: "start", id: id})
	f.mu.Unlock()
	return f.startErr
}

func (f *fakeSchedulerLauncher) Stop(ctx context.Context, id string, confirm bool) error {
	f.mu.Lock()
	f.actions = append(f.actions, schedulerAction{action: "stop", id: id, confirm: confirm})
	f.mu.Unlock()
	return f.stopErr
}

func (f *fakeSchedulerLauncher) persistSchedule(wf Workflow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wfs[wf.ID] = wf
	return nil
}

func (f *fakeSchedulerLauncher) actionCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.actions)
}

func TestParseTimeOfDay(t *testing.T) {
	cases := []struct {
		in         string
		wantHour   int
		wantMinute int
		wantOK     bool
	}{
		{"08:00", 8, 0, true},
		{"23:59", 23, 59, true},
		{"00:00", 0, 0, true},
		{"24:00", 0, 0, false},
		{"08:60", 0, 0, false},
		{"not-a-time", 0, 0, false},
		{"", 0, 0, false},
		{"8", 0, 0, false},
	}
	for _, c := range cases {
		hh, mm, ok := parseTimeOfDay(c.in)
		if ok != c.wantOK || (ok && (hh != c.wantHour || mm != c.wantMinute)) {
			t.Errorf("parseTimeOfDay(%q) = (%d, %d, %v), want (%d, %d, %v)", c.in, hh, mm, ok, c.wantHour, c.wantMinute, c.wantOK)
		}
	}
}

func TestOccurrenceAtOnce(t *testing.T) {
	at := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	sched := Schedule{Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}
	occ, ok := occurrenceAt(sched, time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC))
	if !ok || !occ.Equal(at) {
		t.Fatalf("occurrenceAt(once) = (%v, %v), want (%v, true)", occ, ok, at)
	}
}

func TestOccurrenceAtDaily(t *testing.T) {
	sched := Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "08:00"}
	now := time.Date(2026, 7, 20, 12, 34, 0, 0, time.UTC)
	occ, ok := occurrenceAt(sched, now)
	want := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	if !ok || !occ.Equal(want) {
		t.Fatalf("occurrenceAt(daily) = (%v, %v), want (%v, true)", occ, ok, want)
	}
}

func TestOccurrenceAtWeeklyMatchesOnlyItsWeekday(t *testing.T) {
	monday := 1
	sched := Schedule{Kind: ScheduleWeekly, Action: ScheduleActionStart, TimeOfDay: "08:00", Weekday: &monday}

	// 2026-07-20 ist ein Montag.
	onMonday := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	if occ, ok := occurrenceAt(sched, onMonday); !ok || !occ.Equal(time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("occurrenceAt(weekly, Montag) = (%v, %v), want match", occ, ok)
	}

	onTuesday := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	if _, ok := occurrenceAt(sched, onTuesday); ok {
		t.Fatalf("occurrenceAt(weekly, Dienstag) matched, want no match (falscher Wochentag)")
	}
}

func TestSchedulerFiresOnceScheduleWithinFireWindow(t *testing.T) {
	fireAt := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	wf := Workflow{
		ID:   "wf1",
		Name: "test",
		Definition: Definition{
			Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
			Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &fireAt}},
		},
	}
	launcher := newFakeSchedulerLauncher(wf)
	sched := NewScheduler(launcher)
	sched.now = func() time.Time { return fireAt.Add(10 * time.Second) } // knapp innerhalb fireWindow

	sched.tick()

	if launcher.actionCount() != 1 {
		t.Fatalf("actions = %+v, want exactly one Start", launcher.actions)
	}
	if launcher.actions[0].action != "start" || launcher.actions[0].id != "wf1" {
		t.Fatalf("action = %+v, want start on wf1", launcher.actions[0])
	}

	// LastFiredAt muss persistiert worden sein — ein zweiter Tick zum
	// selben (oder noch innerhalb des Fensters liegenden) Zeitpunkt darf
	// nicht erneut feuern.
	sched.tick()
	if launcher.actionCount() != 1 {
		t.Fatalf("actions after second tick = %+v, want still exactly one (no re-fire)", launcher.actions)
	}
}

func TestSchedulerSkipsStaleOccurrenceVerfallenLassen(t *testing.T) {
	fireAt := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	wf := Workflow{
		ID:   "wf1",
		Name: "test",
		Definition: Definition{
			Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
			Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &fireAt}},
		},
	}
	launcher := newFakeSchedulerLauncher(wf)
	sched := NewScheduler(launcher)
	// Deutlich außerhalb von fireWindow (z. B. Orchestrator war Stunden
	// down) — "verfallen lassen", s. Schedule-Doku in types.go.
	sched.now = func() time.Time { return fireAt.Add(3 * time.Hour) }

	sched.tick()

	if launcher.actionCount() != 0 {
		t.Fatalf("actions = %+v, want none (missed occurrence must expire, not catch up)", launcher.actions)
	}
}

func TestSchedulerDoesNotFireBeforeOccurrence(t *testing.T) {
	fireAt := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	wf := Workflow{
		ID:   "wf1",
		Name: "test",
		Definition: Definition{
			Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
			Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &fireAt}},
		},
	}
	launcher := newFakeSchedulerLauncher(wf)
	sched := NewScheduler(launcher)
	sched.now = func() time.Time { return fireAt.Add(-1 * time.Minute) }

	sched.tick()

	if launcher.actionCount() != 0 {
		t.Fatalf("actions = %+v, want none (occurrence is still in the future)", launcher.actions)
	}
}

func TestSchedulerStopFiresWithConfirmTrue(t *testing.T) {
	fireAt := time.Date(2026, 7, 20, 22, 0, 0, 0, time.UTC)
	wf := Workflow{
		ID:   "wf1",
		Name: "test",
		Definition: Definition{
			Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
			Settings:  Settings{ConfirmStop: true},
			Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStop, At: &fireAt}},
		},
	}
	launcher := newFakeSchedulerLauncher(wf)
	sched := NewScheduler(launcher)
	sched.now = func() time.Time { return fireAt.Add(5 * time.Second) }

	sched.tick()

	if launcher.actionCount() != 1 || launcher.actions[0].action != "stop" || !launcher.actions[0].confirm {
		t.Fatalf("actions = %+v, want one stop with confirm=true even though ConfirmStop is set", launcher.actions)
	}
}

// TestSchedulerLastFiredAtSurvivesConcurrentRunStart reproduziert den
// live gefundenen Race in voller Länge (2026-07-18, docs/decisions.md):
// gegen den echten *Service (nicht fakeSchedulerLauncher) — Start()
// kehrt sofort zurück, runStart() läuft als Hintergrund-Goroutine weiter
// und ruft dabei mehrfach UpdateRuntime() mit einem zu ihrem eigenen
// Start erfassten wf-Stand auf. Ohne den Store.UpdateRuntime()-Fix würde
// eine dieser Aufrufe die LastFiredAt-Markierung, die persistSchedule()
// direkt nach fire() gesetzt hat, wieder verwerfen — der nächste Tick
// würde dann ein zweites Mal feuern.
func TestSchedulerLastFiredAtSurvivesConcurrentRunStart(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	store := newFakeStore()
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(store, nodes, &fakeGraph{}, l)

	fireAt := time.Now().Add(-5 * time.Second) // bereits fällig
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &fireAt}},
	}
	wf, err := svc.Create("wf", def)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	scheduler := NewScheduler(svc)
	scheduler.now = time.Now

	// Erster Tick: feuert Start() (kehrt sofort zurück), runStart läuft
	// im Hintergrund weiter (wartet bis zu registrationTimeout auf die
	// noch nicht registrierte Rolle "src").
	scheduler.tick()

	afterFirstTick, _ := svc.Get(wf.ID)
	if len(afterFirstTick.Definition.Schedules) != 1 || afterFirstTick.Definition.Schedules[0].LastFiredAt == nil {
		t.Fatalf("after first tick, Schedules = %+v, want LastFiredAt set", afterFirstTick.Definition.Schedules)
	}

	// Registrierung nachliefern, damit runStart abschließt — dabei ruft
	// es intern mehrfach UpdateRuntime() auf (Zwischenstand + Endstand).
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		instID, started := l.instances["omp-source"], len(l.started) > 0
		l.mu.Unlock()
		if started {
			nodes.add(registry.NodeView{ID: "node-src", InstanceID: instID})
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	waitForStatus(t, svc, wf.ID, StatusStarted)

	// Zweiter Tick (der nächste 20s-Takt in der Praxis): darf nicht noch
	// einmal feuern.
	scheduler.tick()

	final, _ := svc.Get(wf.ID)
	if final.Status != StatusStarted {
		t.Fatalf("Status nach runStart-Abschluss = %q, want %q", final.Status, StatusStarted)
	}
	if len(final.Definition.Schedules) != 1 || final.Definition.Schedules[0].LastFiredAt == nil {
		t.Fatalf("LastFiredAt nach runStart-Abschluss = %+v, want weiterhin gesetzt (darf nicht von UpdateRuntime() verworfen worden sein)", final.Definition.Schedules)
	}

	l.mu.Lock()
	startCount := len(l.started)
	l.mu.Unlock()
	if startCount != 1 {
		t.Fatalf("launcher.Start()-Aufrufe = %d, want genau 1 (kein Doppel-Feuern)", startCount)
	}
}

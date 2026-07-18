package workflows

import (
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// testDB liefert eine migrierte, verbundene Datenbank für Tests (gleiches
// Muster wie internal/snapshots/store_test.go).
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("OMP_POSTGRES_URL")
	if dsn == "" {
		dsn = "postgres://omp:omp@localhost:5432/omp?sslmode=disable"
	}
	database, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("postgres nicht erreichbar (%v) — für diesen Test `make up` starten", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if _, err := database.Exec(`DELETE FROM workflows`); err != nil {
		t.Fatalf("cleanup workflows table: %v", err)
	}
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM workflows`) })
	return database
}

func TestStoreGetUnknownIDReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	_, err := s.Get("does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestStorePutThenGetRoundTrips(t *testing.T) {
	s := NewStore(testDB(t))
	wf := Workflow{
		ID:     "wf1",
		Name:   "Regieplatz",
		Status: StatusStopped,
		Definition: Definition{
			Roles:       []Role{{Name: "src", NodeType: "omp-source"}},
			Connections: []Connection{{FromRole: "src", ToRole: "src"}},
		},
	}
	if err := s.Put(wf); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	got, err := s.Get("wf1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Name != "Regieplatz" || len(got.Definition.Roles) != 1 {
		t.Errorf("Get() = %+v, want roundtripped workflow", got)
	}
}

func TestStorePutOverwritesExisting(t *testing.T) {
	s := NewStore(testDB(t))
	_ = s.Put(Workflow{ID: "wf1", Name: "v1", Status: StatusStopped})
	_ = s.Put(Workflow{ID: "wf1", Name: "v2", Status: StatusStarted})

	got, err := s.Get("wf1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Name != "v2" || got.Status != StatusStarted {
		t.Errorf("Get() = %+v, want overwritten to v2/started", got)
	}
}

func TestStoreListReturnsEmptySliceInitially(t *testing.T) {
	s := NewStore(testDB(t))
	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Errorf("List() = %v, want empty non-nil slice", list)
	}
}

func TestStoreDeleteIsIdempotent(t *testing.T) {
	s := NewStore(testDB(t))
	_ = s.Put(Workflow{ID: "wf1", Name: "v1", Status: StatusStopped})

	if err := s.Delete("wf1"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := s.Delete("wf1"); err != nil {
		t.Fatalf("Delete() second call error = %v, want nil (idempotent)", err)
	}
	if _, err := s.Get("wf1"); err != ErrNotFound {
		t.Fatalf("Get() after Delete() error = %v, want ErrNotFound", err)
	}
}

func TestStoreUpdateSchedulesRoundTrips(t *testing.T) {
	s := NewStore(testDB(t))
	at := mustParseTime(t, "2026-07-20T08:00:00Z")
	wf := Workflow{
		ID:     "wf1",
		Name:   "Regieplatz",
		Status: StatusStopped,
		Definition: Definition{
			Roles: []Role{{Name: "src", NodeType: "omp-source"}},
		},
	}
	if err := s.Put(wf); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	if err := s.UpdateSchedules("wf1", []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}}); err != nil {
		t.Fatalf("UpdateSchedules() error = %v", err)
	}

	got, err := s.Get("wf1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if len(got.Definition.Schedules) != 1 || got.Definition.Schedules[0].ID != "s1" {
		t.Fatalf("Get() Schedules = %+v, want one entry s1", got.Definition.Schedules)
	}
	// Übrige Felder (insbesondere Name/Status, per Put() geschrieben)
	// müssen von UpdateSchedules unangetastet bleiben — es ändert
	// ausschließlich den definition.schedules-Pfad.
	if got.Name != "Regieplatz" || got.Status != StatusStopped {
		t.Fatalf("Get() = %+v, want Name/Status untouched by UpdateSchedules", got)
	}
}

// TestStoreUpdateSchedulesSurvivesLaterConcurrentPut reproduziert den
// live gefundenen Race (2026-07-18, docs/decisions.md): runStart/
// runStop schreiben über Put() den *gesamten* Workflow-Blob mehrfach
// während einer Hintergrund-Operation zurück. Ein Get()+Put()-Ansatz im
// Scheduler wird von einem SPÄTEREN, blinden Put() rückgängig gemacht —
// genau das hat das dreifache Feuern eines "once"-Schedules verursacht.
// UpdateSchedules (jsonb_set auf nur den schedules-Unterpfad) übersteht
// das, solange sein eigener Aufruf NACH dem Blind-Put() liegt.
func TestStoreUpdateSchedulesSurvivesLaterConcurrentPut(t *testing.T) {
	s := NewStore(testDB(t))
	wf := Workflow{ID: "wf1", Name: "Regieplatz", Status: StatusStopped}
	if err := s.Put(wf); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	// Simuliert runStart's spätes, blindes Put() mit einem VOR dem
	// nachfolgenden UpdateSchedules()-Aufruf erfassten wf-Stand
	// (Schedules leer).
	stale := wf
	stale.Status = StatusStarted
	if err := s.Put(stale); err != nil {
		t.Fatalf("Put(stale) error = %v", err)
	}

	at := mustParseTime(t, "2026-07-20T08:00:00Z")
	if err := s.UpdateSchedules("wf1", []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}}); err != nil {
		t.Fatalf("UpdateSchedules() error = %v", err)
	}

	got, err := s.Get("wf1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if len(got.Definition.Schedules) != 1 || got.Status != StatusStarted {
		t.Fatalf("Get() = %+v, want schedule set AND Status (from the earlier Put()) preserved", got)
	}
}

// TestStoreUpdateRuntimePreservesSchedules ist die andere Hälfte des
// Live-Fund-Fixes (2026-07-18, docs/decisions.md): runStart hält
// während seiner asynchronen Ausführung nur einen zu ihrem eigenen Start
// erfassten wf-Stand und ruft UpdateRuntime() ggf. NACHDEM der Scheduler
// per UpdateSchedules() bereits LastFiredAt gesetzt hat — UpdateRuntime
// darf diese zwischenzeitliche Änderung nicht verwerfen, obwohl der
// aufrufende Code selbst gar keine Ahnung von schedules hat (übergibt
// z. B. Definition.Schedules == nil).
func TestStoreUpdateRuntimePreservesSchedules(t *testing.T) {
	s := NewStore(testDB(t))
	wf := Workflow{ID: "wf1", Name: "Regieplatz", Status: StatusStopped}
	if err := s.Put(wf); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	at := mustParseTime(t, "2026-07-20T08:00:00Z")
	if err := s.UpdateSchedules("wf1", []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}}); err != nil {
		t.Fatalf("UpdateSchedules() error = %v", err)
	}

	// runStart-artiger Aufruf: sein wf-Stand kennt schedules gar nicht
	// (nil), setzt nur Status.
	stale := Workflow{ID: "wf1", Name: "Regieplatz", Status: StatusStarted}
	if err := s.UpdateRuntime(stale); err != nil {
		t.Fatalf("UpdateRuntime() error = %v", err)
	}

	got, err := s.Get("wf1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Status != StatusStarted {
		t.Fatalf("Get().Status = %q, want %q (UpdateRuntime must still apply its own fields)", got.Status, StatusStarted)
	}
	if len(got.Definition.Schedules) != 1 || got.Definition.Schedules[0].ID != "s1" {
		t.Fatalf("Get().Definition.Schedules = %+v, want the schedule preserved despite UpdateRuntime(stale)", got.Definition.Schedules)
	}
}

func mustParseTime(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("time.Parse(%q) error = %v", s, err)
	}
	return ts
}

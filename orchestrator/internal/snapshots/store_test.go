package snapshots

import (
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// testDB liefert eine migrierte, verbundene Datenbank für Tests (gleiches
// Muster wie internal/layouts/store_test.go/internal/db/db_test.go) und
// leert die snapshots-Tabelle davor/danach — anders als layouts' per-Test
// eindeutigem Namen liest List() hier alle Zeilen, Tests würden sich sonst
// gegenseitig verfälschen. Sicher, weil Go-Tests innerhalb eines Pakets
// standardmäßig sequenziell laufen (kein t.Parallel() hier).
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
	if _, err := database.Exec(`DELETE FROM snapshots`); err != nil {
		t.Fatalf("cleanup snapshots table: %v", err)
	}
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM snapshots`) })
	return database
}

func TestGetUnknownIDReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	_, err := s.Get("does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestPutThenGetRoundTrips(t *testing.T) {
	s := NewStore(testDB(t))
	snap := Snapshot{ID: "s1", Label: "Szene 1", Edges: []Edge{{FromSender: "a", ToReceiver: "b"}}}

	if err := s.Put(snap); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	got, err := s.Get("s1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Label != "Szene 1" || len(got.Edges) != 1 {
		t.Errorf("Get() = %+v, want roundtripped snapshot", got)
	}
}

func TestListReturnsEmptySliceInitially(t *testing.T) {
	s := NewStore(testDB(t))
	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Errorf("List() = %v, want empty non-nil slice", list)
	}
}

func TestListOrdersByCreatedAt(t *testing.T) {
	s := NewStore(testDB(t))
	now := time.Now()
	_ = s.Put(Snapshot{ID: "later", CreatedAt: now.Add(time.Minute)})
	_ = s.Put(Snapshot{ID: "earlier", CreatedAt: now})

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 2 || list[0].ID != "earlier" || list[1].ID != "later" {
		t.Fatalf("List() = %+v, want [earlier, later]", list)
	}
}

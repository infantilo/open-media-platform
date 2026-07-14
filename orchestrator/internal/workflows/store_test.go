package workflows

import (
	"database/sql"
	"os"
	"testing"

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

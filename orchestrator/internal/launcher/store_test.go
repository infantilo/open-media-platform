package launcher

import (
	"database/sql"
	"os"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// testDB liefert eine migrierte, verbundene Datenbank für Tests (gleiches
// Muster wie internal/workflows/store_test.go).
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
	if _, err := database.Exec(`DELETE FROM instances`); err != nil {
		t.Fatalf("cleanup instances table: %v", err)
	}
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM instances`) })
	return database
}

func findByID(list []Instance, id string) (Instance, bool) {
	for _, inst := range list {
		if inst.ID == id {
			return inst, true
		}
	}
	return Instance{}, false
}

func TestStorePutThenListRoundTrips(t *testing.T) {
	s := NewStore(testDB(t))
	inst := Instance{ID: "i1", Type: "omp-source", Label: "Source (i1)", PID: 4242, ExtraEnv: map[string]string{"OMP_WIDTH": "1280"}}
	if err := s.Put(inst); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	got, ok := findByID(list, "i1")
	if !ok {
		t.Fatalf("List() = %+v, want an entry for i1", list)
	}
	if got.Type != "omp-source" || got.PID != 4242 || got.ExtraEnv["OMP_WIDTH"] != "1280" {
		t.Errorf("List()[i1] = %+v, want roundtripped instance", got)
	}
}

func TestStorePutOverwritesExisting(t *testing.T) {
	s := NewStore(testDB(t))
	_ = s.Put(Instance{ID: "i1", Type: "omp-source", PID: 100})
	_ = s.Put(Instance{ID: "i1", Type: "omp-source", PID: 200, RestartCount: 1})

	list, _ := s.List()
	got, ok := findByID(list, "i1")
	if !ok || got.PID != 200 || got.RestartCount != 1 {
		t.Errorf("List()[i1] = %+v, ok=%v, want overwritten to PID 200/RestartCount 1", got, ok)
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
	_ = s.Put(Instance{ID: "i1", Type: "omp-source"})

	if err := s.Delete("i1"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := s.Delete("i1"); err != nil {
		t.Fatalf("Delete() second call error = %v, want nil (idempotent)", err)
	}
	list, _ := s.List()
	if _, ok := findByID(list, "i1"); ok {
		t.Errorf("List() after Delete() still contains i1: %+v", list)
	}
}

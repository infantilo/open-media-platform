package layouts

import (
	"database/sql"
	"encoding/json"
	"os"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// testDB liefert eine migrierte, verbundene Datenbank für Tests —
// überspringt sich selbst, wenn Postgres nicht erreichbar ist (gleiches
// Muster wie internal/db/db_test.go: SQL-Korrektheit lässt sich ohne
// echte DB nicht sinnvoll prüfen, aber kein harter Zwang zu einer
// laufenden Instanz für jeden Testlauf).
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
	return database
}

// cleanName liefert einen pro Test eindeutigen Layout-Namen (Primary Key
// in Postgres, anders als beim alten Datei-Backend teilen sich parallele
// Testläufe dieselbe Tabelle) und räumt ihn nach dem Test wieder auf.
func cleanName(t *testing.T, database *sql.DB, name string) string {
	t.Helper()
	unique := name + "_" + t.Name()
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM layouts WHERE name = $1`, unique)
	})
	return unique
}

func TestGetUnknownNameReturnsNotFound(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	name := cleanName(t, database, "default")

	_, err := s.Get(name)
	if err != ErrNotFound {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestPutThenGetRoundTrips(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	name := cleanName(t, database, "default")
	body := json.RawMessage(`{"positions":{"node-1":{"x":1,"y":2}}}`)

	if err := s.Put(name, body); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	got, err := s.Get(name)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got) != string(body) {
		t.Errorf("Get() = %s, want %s", got, body)
	}
}

func TestPutOverwritesExisting(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	name := cleanName(t, database, "default")

	if err := s.Put(name, json.RawMessage(`{"v":1}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := s.Put(name, json.RawMessage(`{"v":2}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	got, _ := s.Get(name)
	if string(got) != `{"v":2}` {
		t.Errorf("Get() = %s, want {\"v\":2}", got)
	}
}

func TestPutRejectsInvalidJSON(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	name := cleanName(t, database, "default")

	if err := s.Put(name, json.RawMessage(`not json`)); err == nil {
		t.Fatal("Put(invalid JSON) error = nil, want error")
	}
}

func TestInvalidNameRejected(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	for _, name := range []string{"../escape", "a/b", "a\\b", "", "with space"} {
		if err := s.Put(name, json.RawMessage(`{}`)); err != ErrInvalidName {
			t.Errorf("Put(%q) error = %v, want ErrInvalidName", name, err)
		}
		if _, err := s.Get(name); err != ErrInvalidName {
			t.Errorf("Get(%q) error = %v, want ErrInvalidName", name, err)
		}
	}
}

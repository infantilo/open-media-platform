package audit

import (
	"database/sql"
	"os"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

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
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestLogAndList(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	username := "test-audit-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	store.Log(username, "PATCH", "/api/v1/nodes/n1/params/gain", "inst-mixer", 200)
	store.Log(username, "POST", "/api/v1/graph/edges", "", 403)

	entries, err := store.List(100)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	found := 0
	for _, e := range entries {
		if e.Username != username {
			continue
		}
		found++
		if e.Method == "PATCH" && (e.NodeID != "inst-mixer" || e.Status != 200) {
			t.Errorf("PATCH entry = %+v, unexpected", e)
		}
		if e.Method == "POST" && (e.NodeID != "" || e.Status != 403) {
			t.Errorf("POST entry = %+v, unexpected", e)
		}
	}
	if found != 2 {
		t.Fatalf("List() found %d entries for %s, want 2", found, username)
	}
}

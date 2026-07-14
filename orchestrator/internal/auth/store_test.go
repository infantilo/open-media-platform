package auth

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// testDB verbindet gegen die lokale Dev-Postgres-Instanz (gleiches Muster
// wie internal/db/db_test.go) und überspringt den Test, wenn keine
// erreichbar ist. Jeder Test räumt seine users-Zeilen selbst wieder auf,
// damit Tests unabhängig von Ausführungsreihenfolge/vorherigen Läufen
// bleiben (keine dedizierte Test-DB, dieselbe wie der Dev-Betrieb).
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

func TestStoreCreateAndByUsername(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-create-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username) })

	created, err := store.Create(ctx, username, "hash-value")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" || created.Username != username {
		t.Fatalf("Create() = %+v, unexpected", created)
	}

	got, ok, err := store.ByUsername(ctx, username)
	if err != nil {
		t.Fatalf("ByUsername() error = %v", err)
	}
	if !ok || got.ID != created.ID || got.PasswordHash != "hash-value" {
		t.Fatalf("ByUsername() = %+v, ok=%v, want match for %+v", got, ok, created)
	}
}

func TestStoreCreateDuplicateUsernameFails(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-dup-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username) })

	if _, err := store.Create(ctx, username, "hash-a"); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	if _, err := store.Create(ctx, username, "hash-b"); err != ErrUserExists {
		t.Fatalf("second Create() error = %v, want ErrUserExists", err)
	}
}

func TestStoreByUsernameMissingReturnsNotOK(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	_, ok, err := store.ByUsername(context.Background(), "does-not-exist-"+mustNewID(t))
	if err != nil {
		t.Fatalf("ByUsername() error = %v", err)
	}
	if ok {
		t.Errorf("ByUsername() ok = true, want false for missing user")
	}
}

func mustNewID(t *testing.T) string {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatalf("newID() error = %v", err)
	}
	return id
}

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
	// Kein impliziter Fallback auf die lokale Standard-Dev-DSN mehr
	// (Nachtrag 108, docs/decisions.md): genau dieser Fallback verband
	// sich bei fehlendem OMP_POSTGRES_URL unbemerkt mit der echten,
	// dauerhaft laufenden Dev-Postgres (identische Default-DSN) und
	// löschte dort per anschließendem `DELETE FROM ...`/Cleanup echte,
	// nie absichtlich in Kauf genommene Daten (u. a. den gespeicherten
	// Workflow "Regieplatz 1"). Wer diese Tests laufen lassen will,
	// muss OMP_POSTGRES_URL jetzt explizit selbst setzen — ein
	// bewusster Akt statt eines stillen Defaults.
	dsn := os.Getenv("OMP_POSTGRES_URL")
	if dsn == "" {
		t.Skip("OMP_POSTGRES_URL nicht gesetzt — DB-Test übersprungen (kein impliziter Fallback mehr, s. docs/decisions.md Nachtrag 108)")
	}
	database, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("postgres nicht erreichbar (%v)", err)
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

// TestStoreRevokeSessions (Sicherheits-Härtung 2026-08-10) — s. service_test.go
// für den End-to-End-Test über Authenticate hinweg.
func TestStoreRevokeSessionsIncrementsEpoch(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-revoke-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username) })

	created, err := store.Create(ctx, username, "hash-value")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.SessionsEpoch != 0 {
		t.Fatalf("SessionsEpoch = %d on a freshly created user, want 0", created.SessionsEpoch)
	}

	if err := store.RevokeSessions(ctx, username); err != nil {
		t.Fatalf("RevokeSessions() error = %v", err)
	}

	got, ok, err := store.ByUsername(ctx, username)
	if err != nil || !ok {
		t.Fatalf("ByUsername() = (ok=%v, err=%v)", ok, err)
	}
	if got.SessionsEpoch != 1 {
		t.Fatalf("SessionsEpoch = %d after one RevokeSessions(), want 1", got.SessionsEpoch)
	}

	if err := store.RevokeSessions(ctx, username); err != nil {
		t.Fatalf("second RevokeSessions() error = %v", err)
	}
	got, _, err = store.ByUsername(ctx, username)
	if err != nil {
		t.Fatalf("ByUsername() error = %v", err)
	}
	if got.SessionsEpoch != 2 {
		t.Fatalf("SessionsEpoch = %d after two RevokeSessions() calls, want 2", got.SessionsEpoch)
	}
}

func TestStoreRevokeSessionsUnknownUserReturnsNotFound(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	if err := store.RevokeSessions(context.Background(), "does-not-exist-"+mustNewID(t)); err != ErrUserNotFound {
		t.Fatalf("RevokeSessions() error = %v, want ErrUserNotFound", err)
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

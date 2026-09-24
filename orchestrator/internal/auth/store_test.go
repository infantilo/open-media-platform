package auth

import (
	"context"
	"database/sql"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"testing"
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
	// Isolierte Testdatenbank je Paket statt der echten App-Datenbank
	// hinter OMP_POSTGRES_URL (Nachtrag 270, s. internal/dbtest).
	return dbtest.Open(t)
}

func TestStoreCreateAndByUsername(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-create-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username) })

	created, err := store.Create(ctx, username, "hash-value", "default")
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

	if _, err := store.Create(ctx, username, "hash-a", "default"); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	if _, err := store.Create(ctx, username, "hash-b", "default"); err != ErrUserExists {
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

	created, err := store.Create(ctx, username, "hash-value", "default")
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

func TestStoreUpdateOrg(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-updateorg-" + mustNewID(t)
	orgID := "test-org-" + mustNewID(t)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username)
		_, _ = database.Exec(`DELETE FROM organizations WHERE id = $1`, orgID)
	})
	if _, err := database.Exec(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, orgID, "Test Org"); err != nil {
		t.Fatalf("seed organization: %v", err)
	}

	if _, err := store.Create(ctx, username, "hash-value", "default"); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := store.UpdateOrg(ctx, username, orgID); err != nil {
		t.Fatalf("UpdateOrg() error = %v", err)
	}
	got, ok, err := store.ByUsername(ctx, username)
	if err != nil || !ok {
		t.Fatalf("ByUsername() = (ok=%v, err=%v)", ok, err)
	}
	if got.OrgID != orgID {
		t.Fatalf("OrgID = %q after UpdateOrg(), want %q", got.OrgID, orgID)
	}
}

func TestStoreUpdateOrgUnknownUserReturnsNotFound(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	if err := store.UpdateOrg(context.Background(), "does-not-exist-"+mustNewID(t), "default"); err != ErrUserNotFound {
		t.Fatalf("UpdateOrg() error = %v, want ErrUserNotFound", err)
	}
}

// TestStoreUpdateOrgUnknownOrgFails belegt, dass ein erfundenes orgID
// den Fremdschlüssel auf organizations verletzt statt still zu
// akzeptieren (httpapi.handleUpdateUserOrg übersetzt das in 400, s.
// dortige Doku) — kein Freitext-Feld, sondern eine echte Beziehung.
func TestStoreUpdateOrgUnknownOrgFails(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	ctx := context.Background()
	username := "test-store-updateorg-badorg-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM users WHERE username = $1`, username) })
	if _, err := store.Create(ctx, username, "hash-value", "default"); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := store.UpdateOrg(ctx, username, "does-not-exist-"+mustNewID(t)); err == nil {
		t.Fatal("UpdateOrg() with unknown orgID = nil error, want a foreign key violation")
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

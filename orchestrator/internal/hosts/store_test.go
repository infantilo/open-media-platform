package hosts

import (
	"database/sql"
	"os"
	"testing"
	"time"

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

func TestBootstrapTokenCreateAndConsumeOnce(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM host_bootstrap_tokens WHERE created_by = 'test-hosts-store'`)
	})

	token, expiresAt, err := store.CreateBootstrapToken("test-hosts-store", time.Hour)
	if err != nil {
		t.Fatalf("CreateBootstrapToken() error = %v", err)
	}
	if token == "" || !expiresAt.After(time.Now()) {
		t.Fatalf("CreateBootstrapToken() = %q, %v, unexpected", token, expiresAt)
	}

	if err := store.ConsumeBootstrapToken(token); err != nil {
		t.Fatalf("first ConsumeBootstrapToken() error = %v", err)
	}
	if err := store.ConsumeBootstrapToken(token); err != ErrInvalidToken {
		t.Fatalf("second ConsumeBootstrapToken() error = %v, want ErrInvalidToken", err)
	}
}

func TestBootstrapTokenExpired(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM host_bootstrap_tokens WHERE created_by = 'test-hosts-store-expired'`)
	})

	token, _, err := store.CreateBootstrapToken("test-hosts-store-expired", -time.Minute)
	if err != nil {
		t.Fatalf("CreateBootstrapToken() error = %v", err)
	}

	if err := store.ConsumeBootstrapToken(token); err != ErrInvalidToken {
		t.Fatalf("ConsumeBootstrapToken() error = %v, want ErrInvalidToken for expired token", err)
	}
}

func TestBootstrapTokenUnknown(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)

	if err := store.ConsumeBootstrapToken("does-not-exist"); err != ErrInvalidToken {
		t.Fatalf("ConsumeBootstrapToken() error = %v, want ErrInvalidToken for unknown token", err)
	}
}

func TestCreateHostAndListHosts(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	label := "test-hosts-store-host-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM hosts WHERE label = $1`, label) })

	created, err := store.CreateHost(label, "test-hostname", []byte(`{"cores":8}`))
	if err != nil {
		t.Fatalf("CreateHost() error = %v", err)
	}
	if created.ID == "" || created.RegisteredAt.IsZero() {
		t.Fatalf("CreateHost() = %+v, unexpected", created)
	}

	all, err := store.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts() error = %v", err)
	}
	found := false
	for _, h := range all {
		if h.ID == created.ID {
			found = true
			if h.Label != label || h.Hostname != "test-hostname" {
				t.Errorf("ListHosts() found host = %+v, unexpected", h)
			}
		}
	}
	if !found {
		t.Fatalf("ListHosts() did not contain created host %+v", created)
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

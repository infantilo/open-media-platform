package authz

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

func TestStoreCreateLoadDelete(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	created, err := store.Create(subject, "inst-mixer", VerbOperate)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" {
		t.Fatalf("Create() = %+v, want non-empty ID", created)
	}

	all, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	found := false
	for _, b := range all {
		if b.ID == created.ID {
			found = true
			if b.Subject != subject || b.NodeID != "inst-mixer" || b.Verb != VerbOperate {
				t.Errorf("Load() found binding = %+v, unexpected", b)
			}
		}
	}
	if !found {
		t.Fatalf("Load() did not contain created binding %+v", created)
	}

	if err := store.Delete(created.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	all, err = store.Load()
	if err != nil {
		t.Fatalf("Load() after delete error = %v", err)
	}
	for _, b := range all {
		if b.ID == created.ID {
			t.Fatalf("Load() after Delete() still contains %+v", b)
		}
	}
}

func TestStoreCheck(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-check-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	if _, err := store.Create(subject, "inst-mixer", VerbOperate); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	ok, err := store.Check(subject, "inst-mixer", VerbOperate)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if !ok {
		t.Errorf("Check(bound node, operate) = false, want true")
	}

	ok, err = store.Check(subject, "inst-mixer", VerbConfigure)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if ok {
		t.Errorf("Check(bound node, configure) = true, want false (only operate granted)")
	}

	ok, err = store.Check(subject, "inst-other", VerbView)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if ok {
		t.Errorf("Check(unbound node, view) = true, want false")
	}
}

func TestStoreCheckWildcard(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-wildcard-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	if _, err := store.Create(subject, AnyNode, VerbAdmin); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	ok, err := store.Check(subject, "any-node-id", VerbAdmin)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if !ok {
		t.Errorf("Check(wildcard binding) = false, want true")
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

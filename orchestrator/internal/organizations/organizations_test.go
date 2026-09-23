package organizations

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM organizations WHERE id != $1`, DefaultOrgID); err != nil {
			t.Fatalf("cleanup organizations: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func TestDefaultOrgExistsAfterMigration(t *testing.T) {
	s := NewStore(testDB(t))
	o, err := s.Get(DefaultOrgID)
	if err != nil {
		t.Fatalf("Get(default) error = %v", err)
	}
	if o.Name != "Default" {
		t.Errorf("Get(default).Name = %q, want %q", o.Name, "Default")
	}
}

func TestCreateGetListDelete(t *testing.T) {
	s := NewStore(testDB(t))

	o, err := s.Create("Kunde A")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if o.ID == "" || o.Name != "Kunde A" {
		t.Fatalf("Create() = %+v, unexpected", o)
	}

	got, err := s.Get(o.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Name != "Kunde A" {
		t.Errorf("Get() = %+v, unexpected", got)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) < 2 {
		t.Fatalf("List() = %+v, want at least default + Kunde A", list)
	}
	if list[0].ID != DefaultOrgID {
		t.Errorf("List()[0] = %+v, want default organization first", list[0])
	}

	if err := s.Delete(o.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := s.Get(o.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get() after delete: error = %v, want ErrNotFound", err)
	}
}

func TestCreateRequiresName(t *testing.T) {
	s := NewStore(testDB(t))
	if _, err := s.Create(""); !errors.Is(err, ErrValidation) {
		t.Errorf("Create(\"\") error = %v, want ErrValidation", err)
	}
}

func TestDeleteDefaultOrgIsRejected(t *testing.T) {
	s := NewStore(testDB(t))
	if err := s.Delete(DefaultOrgID); !errors.Is(err, ErrDefaultOrgImmutable) {
		t.Errorf("Delete(default) error = %v, want ErrDefaultOrgImmutable", err)
	}
	if _, err := s.Get(DefaultOrgID); err != nil {
		t.Errorf("default organization is gone after rejected delete: %v", err)
	}
}

// TestDeleteOrganizationWithMembersFails ist der eigentliche Sinn der
// fehlenden Kaskade: eine Organisation mit noch existierenden
// Mitgliedern darf nicht stillschweigend verschwinden.
func TestDeleteOrganizationWithMembersFails(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)
	o, err := s.Create("Kunde B")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO users (id, username, password_hash, org_id) VALUES ('test-user-fk', 'test-user-fk', 'x', $1)`, o.ID,
	); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM users WHERE id = 'test-user-fk'`) })

	if err := s.Delete(o.ID); err == nil {
		t.Error("Delete() with an existing member: want a foreign-key error, got nil")
	}
}

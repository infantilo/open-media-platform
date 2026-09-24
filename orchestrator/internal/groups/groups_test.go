package groups

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
		if _, err := database.Exec(`DELETE FROM groups`); err != nil {
			t.Fatalf("cleanup groups: %v", err)
		}
		if _, err := database.Exec(`DELETE FROM users`); err != nil {
			t.Fatalf("cleanup users: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func seedUser(t *testing.T, database *sql.DB, username string) {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatalf("newID() error = %v", err)
	}
	if _, err := database.Exec(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'x')`, id, username); err != nil {
		t.Fatalf("seed user %q: %v", username, err)
	}
}

func TestCreateGetListUpdate(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)

	g, err := s.Create("Editors", "Video-Redaktion", "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if g.ID == "" || g.Name != "Editors" {
		t.Fatalf("Create() = %+v, want non-empty ID, Name=Editors", g)
	}

	got, err := s.Get(g.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Description != "Video-Redaktion" {
		t.Errorf("Get() = %+v, unexpected", got)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List() = %d entries, want 1", len(list))
	}

	updated, err := s.UpdateMeta(g.ID, "Editors (Renamed)", "neue Beschreibung")
	if err != nil {
		t.Fatalf("UpdateMeta() error = %v", err)
	}
	if updated.Name != "Editors (Renamed)" || updated.Description != "neue Beschreibung" {
		t.Errorf("UpdateMeta() = %+v, unexpected", updated)
	}
}

func TestCreateRequiresName(t *testing.T) {
	s := NewStore(testDB(t))
	if _, err := s.Create("", "", "alice"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create(empty name) error = %v, want ErrValidation", err)
	}
}

func TestGetUnknownReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	if _, err := s.Get("does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestMembersAddListRemoveIdempotent(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	seedUser(t, database, "alice")
	seedUser(t, database, "bob")

	g, err := s.Create("Ops", "", "admin")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := s.AddMember(g.ID, "alice"); err != nil {
		t.Fatalf("AddMember() error = %v", err)
	}
	// Idempotent — ein zweiter Aufruf mit demselben Mitglied ist kein Fehler.
	if err := s.AddMember(g.ID, "alice"); err != nil {
		t.Fatalf("AddMember() (2nd, same member) error = %v, want nil (idempotent)", err)
	}
	if err := s.AddMember(g.ID, "bob"); err != nil {
		t.Fatalf("AddMember() error = %v", err)
	}

	members, err := s.ListMembers(g.ID)
	if err != nil {
		t.Fatalf("ListMembers() error = %v", err)
	}
	if len(members) != 2 || members[0] != "alice" || members[1] != "bob" {
		t.Fatalf("ListMembers() = %v, want [alice bob]", members)
	}

	groupsForAlice, err := s.GroupsForUser("alice")
	if err != nil {
		t.Fatalf("GroupsForUser() error = %v", err)
	}
	if len(groupsForAlice) != 1 || groupsForAlice[0].ID != g.ID {
		t.Fatalf("GroupsForUser(alice) = %+v, want [%s]", groupsForAlice, g.ID)
	}

	if err := s.RemoveMember(g.ID, "alice"); err != nil {
		t.Fatalf("RemoveMember() error = %v", err)
	}
	// Idempotent.
	if err := s.RemoveMember(g.ID, "alice"); err != nil {
		t.Fatalf("RemoveMember() (2nd) error = %v, want nil (idempotent)", err)
	}
	members, err = s.ListMembers(g.ID)
	if err != nil {
		t.Fatalf("ListMembers() error = %v", err)
	}
	if len(members) != 1 || members[0] != "bob" {
		t.Fatalf("ListMembers() after remove = %v, want [bob]", members)
	}
}

func TestAddMemberUnknownUserFails(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	g, err := s.Create("Ops", "", "admin")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := s.AddMember(g.ID, "does-not-exist-as-a-user"); err == nil {
		t.Fatal("AddMember(unknown user) error = nil, want a foreign key violation")
	}
}

// TestDeleteWithoutCascadeFailsWhileBindingsExist / TestDeleteWithCascade
// belegen den bewussten Unterschied zu storagebackends/organizations:
// Gruppen-Löschung kaskadiert auf Wunsch ihre Bindungen (sicher, s.
// Store.Delete-Doku), statt hart zu blockieren.
func TestDeleteWithoutCascadeSucceedsEvenWithBindings(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	g, err := s.Create("Ops", "", "admin")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	id, _ := newID()
	if _, err := database.Exec(`INSERT INTO role_bindings (id, subject, subject_type, workflow_id, node_id, verb) VALUES ($1, $2, 'group', '', '*', 'operate')`, id, g.ID); err != nil {
		t.Fatalf("seed binding: %v", err)
	}
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE id = $1`, id) })

	n, err := s.CountBindings(g.ID)
	if err != nil {
		t.Fatalf("CountBindings() error = %v", err)
	}
	if n != 1 {
		t.Fatalf("CountBindings() = %d, want 1", n)
	}

	// Ohne Kaskade löscht Delete trotzdem die Gruppe selbst (kein
	// Fremdschlüssel VON role_bindings AUF groups — s. Migrations-Doku);
	// die Bindung bleibt als wirkungslose Leiche zurück, bis sie
	// getrennt aufgeräumt wird. Genau deshalb bietet die HTTP-Schicht
	// den Cascade-Pfad als Standardfall an (s. dortige Doku), dieser
	// Test belegt nur das Store-Verhalten selbst.
	if err := s.Delete(g.ID, false); err != nil {
		t.Fatalf("Delete(cascade=false) error = %v, want nil", err)
	}
	if _, err := s.Get(g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() after Delete() error = %v, want ErrNotFound", err)
	}
}

func TestDeleteWithCascadeRemovesBindings(t *testing.T) {
	database := testDB(t)
	s := NewStore(database)
	g, err := s.Create("Ops", "", "admin")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	id, _ := newID()
	if _, err := database.Exec(`INSERT INTO role_bindings (id, subject, subject_type, workflow_id, node_id, verb) VALUES ($1, $2, 'group', '', '*', 'operate')`, id, g.ID); err != nil {
		t.Fatalf("seed binding: %v", err)
	}

	if err := s.Delete(g.ID, true); err != nil {
		t.Fatalf("Delete(cascade=true) error = %v", err)
	}
	var remaining int
	if err := database.QueryRow(`SELECT count(*) FROM role_bindings WHERE id = $1`, id).Scan(&remaining); err != nil {
		t.Fatalf("count remaining bindings: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("role_bindings after Delete(cascade=true) = %d, want 0", remaining)
	}
}

func TestDeleteUnknownReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	if err := s.Delete("does-not-exist", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete(unknown) error = %v, want ErrNotFound", err)
	}
}

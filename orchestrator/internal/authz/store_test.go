package authz

import (
	"database/sql"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"testing"
)

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

func TestStoreCreateLoadDelete(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	created, err := store.Create(subject, "", "inst-mixer", VerbOperate)
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

// TestStoreDeleteBySubject verifiziert den Nutzerfund 2026-09-24: ein
// gelöschter Nutzer darf keine verwaisten role_bindings zurücklassen
// (subject ist polymorph, kein FK-Cascade möglich — s. DeleteBySubject-
// Doku). Prüft zusätzlich, dass eine gleichlautende Gruppen-Bindung
// (subject_type='group') NICHT mitgelöscht wird.
func TestStoreDeleteBySubject(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	userBinding, err := store.Create(subject, "", "inst-mixer", VerbOperate)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	groupBinding, err := store.CreateGroupBinding(subject, "", "inst-switcher", VerbView)
	if err != nil {
		t.Fatalf("CreateGroupBinding() error = %v", err)
	}

	if err := store.DeleteBySubject(subject); err != nil {
		t.Fatalf("DeleteBySubject() error = %v", err)
	}

	all, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	var sawUser, sawGroup bool
	for _, b := range all {
		if b.ID == userBinding.ID {
			sawUser = true
		}
		if b.ID == groupBinding.ID {
			sawGroup = true
		}
	}
	if sawUser {
		t.Errorf("Load() after DeleteBySubject() still contains the user binding %+v", userBinding)
	}
	if !sawGroup {
		t.Errorf("Load() after DeleteBySubject() lost the group binding %+v, want it untouched", groupBinding)
	}

	if err := store.Delete(groupBinding.ID); err != nil {
		t.Fatalf("cleanup Delete(group binding) error = %v", err)
	}
}

func TestStoreCheck(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-check-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	if _, err := store.Create(subject, "", "inst-mixer", VerbOperate); err != nil {
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

	if _, err := store.Create(subject, "", AnyNode, VerbAdmin); err != nil {
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

// --- Kapitel 12 Teil 4: Workflow-Scope-AuthZ ---

func TestStoreCheckWorkflow(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-workflow-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	if _, err := store.Create(subject, "wf-1", "mixer", VerbOperate); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if ok, err := store.CheckWorkflow(subject, "wf-1", "mixer", VerbOperate); err != nil || !ok {
		t.Fatalf("CheckWorkflow(bound role, operate) = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, _ := store.CheckWorkflow(subject, "wf-1", "mixer", VerbConfigure); ok {
		t.Errorf("CheckWorkflow(bound role, configure) = true, want false (only operate granted)")
	}
	if ok, _ := store.CheckWorkflow(subject, "wf-1", "audio", VerbOperate); ok {
		t.Errorf("CheckWorkflow(different role, same workflow) = true, want false")
	}
	if ok, _ := store.CheckWorkflow(subject, "wf-2", "mixer", VerbOperate); ok {
		t.Errorf("CheckWorkflow(same role name, different workflow) = true, want false")
	}
}

func TestStoreCheckWorkflowWildcardCoversWholeWorkflow(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-workflow-wildcard-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	if _, err := store.Create(subject, "wf-1", AnyNode, VerbOperate); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if ok, _ := store.CheckWorkflow(subject, "wf-1", "mixer", VerbOperate); !ok {
		t.Errorf("CheckWorkflow(workflow wildcard, mixer) = false, want true")
	}
	if ok, _ := store.CheckWorkflow(subject, "wf-1", "audio", VerbOperate); !ok {
		t.Errorf("CheckWorkflow(workflow wildcard, audio) = false, want true")
	}
	if ok, _ := store.CheckWorkflow(subject, "wf-2", "mixer", VerbOperate); ok {
		t.Errorf("CheckWorkflow(different workflow) = true, want false")
	}
}

func TestStoreCheckDoesNotLeakIntoWorkflowScope(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	subject := "test-authz-scope-isolation-" + mustNewID(t)
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, subject) })

	// Eine Workflow-gescopte Bindung auf die Rolle "mixer" darf Check()
	// (die globale/Node-gescopte Prüfung) nicht bestehen lassen, obwohl
	// zufällig ein Node dieselbe ID "mixer" trüge — die beiden
	// Identitäts-Räume (Instanz-ID vs. Rollenname) dürfen sich nie
	// kreuzen (s. Store.Check-Doku).
	if _, err := store.Create(subject, "wf-1", "mixer", VerbAdmin); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if ok, _ := store.Check(subject, "mixer", VerbView); ok {
		t.Errorf("Check() = true, want false (workflow-scoped binding must not leak into the global/node check)")
	}
}

// TestCheckResolvesGroupMembership belegt gruppenbasierte Rechte-
// verwaltung (Nutzerauftrag 2026-09-24): eine Bindung mit
// subject_type='group' muss für jedes Mitglied der Gruppe wirken, für
// einen Nicht-Mitglied-Nutzer NICHT. Echte users/groups/group_members-
// Zeilen statt eines Mocks (gleiche Linie wie der Rest dieses Pakets).
func TestCheckResolvesGroupMembership(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)

	username := "test-authz-groupmember-" + mustNewID(t)
	outsider := "test-authz-outsider-" + mustNewID(t)
	groupID := "test-group-" + mustNewID(t)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM role_bindings WHERE subject = $1`, groupID)
		_, _ = database.Exec(`DELETE FROM groups WHERE id = $1`, groupID)
		_, _ = database.Exec(`DELETE FROM users WHERE username IN ($1, $2)`, username, outsider)
	})
	if _, err := database.Exec(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'x')`, mustNewID(t), username); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'x')`, mustNewID(t), outsider); err != nil {
		t.Fatalf("seed outsider user: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO groups (id, name, created_by) VALUES ($1, $2, 'alice')`, groupID, groupID); err != nil {
		t.Fatalf("seed group: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO group_members (group_id, username) VALUES ($1, $2)`, groupID, username); err != nil {
		t.Fatalf("seed group member: %v", err)
	}

	binding, err := store.CreateGroupBinding(groupID, "", "inst-mixer", VerbOperate)
	if err != nil {
		t.Fatalf("CreateGroupBinding() error = %v", err)
	}
	if binding.SubjectType != SubjectTypeGroup || binding.Subject != groupID {
		t.Fatalf("CreateGroupBinding() = %+v, want SubjectType=group, Subject=%s", binding, groupID)
	}

	if ok, err := store.Check(username, "inst-mixer", VerbOperate); err != nil || !ok {
		t.Errorf("Check(group member) = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := store.Check(outsider, "inst-mixer", VerbOperate); err != nil || ok {
		t.Errorf("Check(non-member) = (%v, %v), want (false, nil)", ok, err)
	}

	// Gleiches für den Workflow-gescopten Pfad.
	wfBinding, err := store.CreateGroupBinding(groupID, "wf-1", "bildmischer", VerbConfigure)
	if err != nil {
		t.Fatalf("CreateGroupBinding() (workflow) error = %v", err)
	}
	t.Cleanup(func() { _ = store.Delete(wfBinding.ID) })
	if ok, err := store.CheckWorkflow(username, "wf-1", "bildmischer", VerbConfigure); err != nil || !ok {
		t.Errorf("CheckWorkflow(group member) = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := store.CheckWorkflow(outsider, "wf-1", "bildmischer", VerbConfigure); err != nil || ok {
		t.Errorf("CheckWorkflow(non-member) = (%v, %v), want (false, nil)", ok, err)
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

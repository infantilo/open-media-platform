package directory

import (
	"context"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestMapStoreSync(t *testing.T) {
	db := dbtest.Open(t)
	ctx := context.Background()
	for _, q := range []string{`DELETE FROM ldap_group_map`, `DELETE FROM group_members`, `DELETE FROM groups`, `DELETE FROM users WHERE username = 'u1'`} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	mustExec := func(q string, a ...any) {
		t.Helper()
		if _, err := db.Exec(q, a...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`INSERT INTO users (id, username, password_hash) VALUES ('id-u1','u1','!')`)
	mustExec(`INSERT INTO groups (id, name, created_by) VALUES ('g-regie','Regie','t'),('g-ton','Ton','t'),('g-hand','Hand','t')`)
	mustExec(`INSERT INTO group_members (group_id, username) VALUES ('g-ton','u1'),('g-hand','u1')`)

	changes := 0
	m := NewMapStore(db)
	m.OnChange = func() { changes++ }
	if err := m.Add(ctx, "Regie1", "g-regie"); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "CN=Ton,OU=G,DC=t", "g-ton"); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "x", "gibt-es-nicht"); err == nil {
		t.Fatal("unbekannte Gruppe angenommen")
	}
	if err := m.Add(ctx, " ", "g-ton"); err == nil {
		t.Fatal("leerer Name angenommen")
	}

	members := func(gid string) bool {
		var n int
		_ = db.QueryRow(`SELECT count(*) FROM group_members WHERE group_id=$1 AND username='u1'`, gid).Scan(&n)
		return n == 1
	}
	// u1 ist im Verzeichnis nur in Regie1: wird Mitglied von Regie, verliert Ton; "Hand" (nicht abgebildet) bleibt.
	ch, err := m.Sync(ctx, "u1", Identity{Groups: []Group{{DN: "CN=Regie1,OU=G,DC=t", CN: "Regie1"}}})
	if err != nil || !ch {
		t.Fatalf("sync: %v %v", ch, err)
	}
	if !members("g-regie") || members("g-ton") || !members("g-hand") {
		t.Fatal("Mitgliedschaften falsch")
	}
	if changes != 1 {
		t.Fatalf("OnChange %d", changes)
	}
	// Zweiter Abgleich ohne Änderung.
	if ch, _ := m.Sync(ctx, "u1", Identity{Groups: []Group{{DN: "CN=Regie1,OU=G,DC=t", CN: "Regie1"}}}); ch || changes != 1 {
		t.Fatal("Änderung gemeldet, obwohl keine")
	}
	// Zuordnung per DN, zwei Verzeichnisgruppen auf eine OMP-Gruppe: ein Treffer genügt.
	_ = m.Add(ctx, "Chefs", "g-ton")
	if _, err := m.Sync(ctx, "u1", Identity{Groups: []Group{{DN: "CN=Ton,OU=G,DC=t", CN: "Ton"}}}); err != nil || !members("g-ton") || members("g-regie") {
		t.Fatalf("DN-Zuordnung: %v", err)
	}
	list, _ := m.List(ctx)
	if len(list) != 3 {
		t.Fatalf("List: %v", list)
	}
	_ = m.Remove(ctx, "Chefs", "g-ton")
	if list, _ = m.List(ctx); len(list) != 2 {
		t.Fatalf("Remove: %v", list)
	}
}

package asset

import (
	"database/sql"
	"errors"
	"testing"
)

// testCollectionsDB — s. testDB (store_test.go) für die grundlegende
// Isolationsbegründung. collections hat keine FK-Beziehung zu assets
// (eine Collection darf leer existieren), braucht daher eigenes
// Aufräumen (cascadiert per Migration nach collection_members).
// asset_relationships cascadiert bereits über assets, testDB(t)s
// eigenes `DELETE FROM assets` reicht dafür.
func testCollectionsDB(t *testing.T) *sql.DB {
	t.Helper()
	database := testDB(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM collections`); err != nil {
			t.Fatalf("cleanup collections: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func TestCollectionCreateGetListUpdateDelete(t *testing.T) {
	s := NewStore(testCollectionsDB(t))

	c, err := s.CreateCollection("Kampagne Q3", "Werbematerial", "alice", "")
	if err != nil {
		t.Fatalf("CreateCollection() error = %v", err)
	}
	if c.ID == "" || c.Title != "Kampagne Q3" || c.CreatedBy != "alice" {
		t.Fatalf("CreateCollection() = %+v, unexpected", c)
	}

	got, err := s.GetCollection(c.ID)
	if err != nil {
		t.Fatalf("GetCollection() error = %v", err)
	}
	if got.Title != "Kampagne Q3" {
		t.Errorf("GetCollection() = %+v, unexpected", got)
	}

	list, err := s.ListCollections()
	if err != nil {
		t.Fatalf("ListCollections() error = %v", err)
	}
	found := false
	for _, item := range list {
		if item.ID == c.ID {
			found = true
		}
	}
	if !found {
		t.Errorf("ListCollections() = %+v, missing %s", list, c.ID)
	}

	updated, err := s.UpdateCollectionMeta(c.ID, "Kampagne Q3 (final)", "Werbematerial, final geschnitten")
	if err != nil {
		t.Fatalf("UpdateCollectionMeta() error = %v", err)
	}
	if updated.Title != "Kampagne Q3 (final)" || !updated.UpdatedAt.After(c.UpdatedAt) {
		t.Errorf("UpdateCollectionMeta() = %+v, unexpected", updated)
	}

	if err := s.DeleteCollection(c.ID); err != nil {
		t.Fatalf("DeleteCollection() error = %v", err)
	}
	if _, err := s.GetCollection(c.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCollection() after delete: error = %v, want ErrNotFound", err)
	}
	// Idempotent: ein zweites Löschen ist kein Fehler.
	if err := s.DeleteCollection(c.ID); err != nil {
		t.Errorf("second DeleteCollection() error = %v, want nil (idempotent)", err)
	}
}

func TestCreateCollectionRequiresTitle(t *testing.T) {
	s := NewStore(testCollectionsDB(t))
	if _, err := s.CreateCollection("", "desc", "alice", ""); !errors.Is(err, ErrValidation) {
		t.Errorf("CreateCollection(title=\"\") error = %v, want ErrValidation", err)
	}
}

func TestCollectionMembership(t *testing.T) {
	s := NewStore(testCollectionsDB(t))

	c, err := s.CreateCollection("Sendung 42", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateCollection() error = %v", err)
	}
	a1, err := s.CreateAsset("VIDEO", "Clip 1", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset(1) error = %v", err)
	}
	a2, err := s.CreateAsset("VIDEO", "Clip 2", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset(2) error = %v", err)
	}

	if err := s.AddCollectionMember(c.ID, a1.ID); err != nil {
		t.Fatalf("AddCollectionMember(1) error = %v", err)
	}
	if err := s.AddCollectionMember(c.ID, a2.ID); err != nil {
		t.Fatalf("AddCollectionMember(2) error = %v", err)
	}
	// Erneutes Hinzufügen desselben Assets ist idempotent, kein Fehler.
	if err := s.AddCollectionMember(c.ID, a1.ID); err != nil {
		t.Fatalf("re-AddCollectionMember(1) error = %v, want nil (idempotent)", err)
	}

	members, err := s.ListCollectionMembers(c.ID)
	if err != nil {
		t.Fatalf("ListCollectionMembers() error = %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("ListCollectionMembers() = %v, want 2 entries", members)
	}

	if err := s.RemoveCollectionMember(c.ID, a1.ID); err != nil {
		t.Fatalf("RemoveCollectionMember() error = %v", err)
	}
	members, err = s.ListCollectionMembers(c.ID)
	if err != nil {
		t.Fatalf("ListCollectionMembers() after remove error = %v", err)
	}
	if len(members) != 1 || members[0] != a2.ID {
		t.Fatalf("ListCollectionMembers() after remove = %v, want [%s]", members, a2.ID)
	}

	// Ein gelöschtes Asset verschwindet automatisch aus der Mitgliedschaft
	// (ON DELETE CASCADE auf assets, s. Migration) — hier per
	// UpdateAssetStatus(deleted) statt eines direkten DELETE geprüft, da
	// asset.Store keine echte DELETE-Methode kennt (B8: "deleted" ist ein
	// Lifecycle-Endzustand, keine Zeilenlöschung) — das FK-Verhalten
	// selbst ist trotzdem live per direktem SQL belegt.
	if _, err := s.db.Exec(`DELETE FROM assets WHERE id = $1`, a2.ID); err != nil {
		t.Fatalf("direct delete of asset: %v", err)
	}
	members, err = s.ListCollectionMembers(c.ID)
	if err != nil {
		t.Fatalf("ListCollectionMembers() after asset delete error = %v", err)
	}
	if len(members) != 0 {
		t.Errorf("ListCollectionMembers() after asset delete = %v, want empty (cascade)", members)
	}
}

func TestAssetRelationships(t *testing.T) {
	s := NewStore(testCollectionsDB(t))

	master, err := s.CreateAsset("VIDEO", "Master", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset(master) error = %v", err)
	}
	proxy, err := s.CreateAsset("VIDEO", "Proxy", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset(proxy) error = %v", err)
	}

	rel, err := s.CreateRelationship(proxy.ID, master.ID, "derived_from", "alice")
	if err != nil {
		t.Fatalf("CreateRelationship() error = %v", err)
	}
	if rel.ID == "" || rel.Type != "derived_from" {
		t.Fatalf("CreateRelationship() = %+v, unexpected", rel)
	}

	// Dieselbe Beziehung ein zweites Mal anlegen ist idempotent (liefert
	// dieselbe Zeile, kein Konflikt-Fehler).
	again, err := s.CreateRelationship(proxy.ID, master.ID, "derived_from", "alice")
	if err != nil {
		t.Fatalf("re-CreateRelationship() error = %v", err)
	}
	if again.ID != rel.ID {
		t.Errorf("re-CreateRelationship() id = %s, want same id %s (idempotent)", again.ID, rel.ID)
	}

	// Beide Richtungen sichtbar: vom Master aus (eingehend) UND vom
	// Proxy aus (ausgehend).
	fromMaster, err := s.ListRelationships(master.ID)
	if err != nil {
		t.Fatalf("ListRelationships(master) error = %v", err)
	}
	if len(fromMaster) != 1 || fromMaster[0].ID != rel.ID {
		t.Fatalf("ListRelationships(master) = %+v, want [%s]", fromMaster, rel.ID)
	}
	fromProxy, err := s.ListRelationships(proxy.ID)
	if err != nil {
		t.Fatalf("ListRelationships(proxy) error = %v", err)
	}
	if len(fromProxy) != 1 || fromProxy[0].ID != rel.ID {
		t.Fatalf("ListRelationships(proxy) = %+v, want [%s]", fromProxy, rel.ID)
	}

	if err := s.DeleteRelationship(rel.ID); err != nil {
		t.Fatalf("DeleteRelationship() error = %v", err)
	}
	fromMaster, err = s.ListRelationships(master.ID)
	if err != nil {
		t.Fatalf("ListRelationships(master) after delete error = %v", err)
	}
	if len(fromMaster) != 0 {
		t.Errorf("ListRelationships(master) after delete = %+v, want empty", fromMaster)
	}
	// Idempotent.
	if err := s.DeleteRelationship(rel.ID); err != nil {
		t.Errorf("second DeleteRelationship() error = %v, want nil (idempotent)", err)
	}
}

func TestCreateRelationshipRejectsSelfAndMissingFields(t *testing.T) {
	s := NewStore(testCollectionsDB(t))
	a, err := s.CreateAsset("VIDEO", "Solo", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}

	if _, err := s.CreateRelationship(a.ID, a.ID, "derived_from", "alice"); !errors.Is(err, ErrValidation) {
		t.Errorf("CreateRelationship(self) error = %v, want ErrValidation", err)
	}
	if _, err := s.CreateRelationship("", a.ID, "derived_from", "alice"); !errors.Is(err, ErrValidation) {
		t.Errorf("CreateRelationship(empty from) error = %v, want ErrValidation", err)
	}
	if _, err := s.CreateRelationship(a.ID, "other", "", "alice"); !errors.Is(err, ErrValidation) {
		t.Errorf("CreateRelationship(empty type) error = %v, want ErrValidation", err)
	}
}

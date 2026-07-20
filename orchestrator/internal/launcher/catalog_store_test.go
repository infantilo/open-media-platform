package launcher

import (
	"reflect"
	"testing"
)

// testCatalogStore liefert einen *CatalogStore auf derselben migrierten
// Test-Datenbank wie testDB (store_test.go), mit eigener Aufräumung der
// `catalog_entries`-Tabelle — getrennt von testDB's `instances`-Cleanup,
// da beide Tabellen unabhängig voneinander befüllt werden.
func testCatalogStore(t *testing.T) *CatalogStore {
	t.Helper()
	database := testDB(t)
	if _, err := database.Exec(`DELETE FROM catalog_entries`); err != nil {
		t.Fatalf("cleanup catalog_entries table: %v", err)
	}
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM catalog_entries`) })
	return NewCatalogStore(database)
}

func TestCatalogStorePutThenListRoundTrips(t *testing.T) {
	s := testCatalogStore(t)
	entry := CatalogEntry{Type: "acme-widget", Label: "Acme Widget", Runner: runnerPodman, Image: "example.com/acme/widget:1.0"}
	if err := s.Put(entry); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 1 || !reflect.DeepEqual(list[0], entry) {
		t.Fatalf("List() = %+v, want [%+v]", list, entry)
	}

	if err := s.Delete(entry.Type); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	list, err = s.List()
	if err != nil {
		t.Fatalf("List() after Delete() error = %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("List() after Delete() = %+v, want empty", list)
	}
}

func TestCatalogStoreDeleteUnknownIsNotAnError(t *testing.T) {
	s := testCatalogStore(t)
	if err := s.Delete("does-not-exist"); err != nil {
		t.Fatalf("Delete() of unknown type error = %v, want nil", err)
	}
}

package catalogdist

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestStoreRoundtripAndStableKey(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM catalog_distribution`)
	_, _ = db.Exec(`DELETE FROM catalog_dist_key`)
	s := NewStore(db)

	p1, pub1, err := s.Key()
	if err != nil {
		t.Fatal(err)
	}
	p2, pub2, err := s.Key()
	if err != nil || pub1 != pub2 || string(p1) != string(p2) {
		t.Fatalf("Schlüssel muss stabil bleiben: %v", err)
	}

	if err := s.Upsert("svc", "1", "h1", DesiredPresent); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("svc", "1", "h1", StateFailed, "boom", "", true); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("svc", "1", "h1", StateFailed, "boom", "", true); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.List()
	if len(rows) != 1 || rows[0].Attempts != 2 || rows[0].State != StateFailed {
		t.Fatalf("%+v", rows)
	}
	if err := s.Set("svc", "1", "h1", StateOK, "fertig", "sha256:x", false); err != nil {
		t.Fatal(err)
	}
	rows, _ = s.List()
	if rows[0].Attempts != 0 || rows[0].ImageID != "sha256:x" {
		t.Fatalf("OK setzt Versuche zurück: %+v", rows[0])
	}
	// Upsert setzt auf pending zurück (Retry/Entfernen)
	s.Upsert("svc", "1", "h1", DesiredAbsent)
	rows, _ = s.List()
	if rows[0].Desired != DesiredAbsent || rows[0].State != StatePending {
		t.Fatalf("%+v", rows[0])
	}
	if err := s.Delete("svc", "1", "h1"); err != nil {
		t.Fatal(err)
	}
	if rows, _ = s.List(); len(rows) != 0 {
		t.Fatal("nicht gelöscht")
	}
}

package asset

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

func deleteAsset(t *testing.T, s *Store, title string) Asset {
	t.Helper()
	a, err := s.CreateAsset("VIDEO", title, "", "alice", "")
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.CreateVersion(a.ID, "", "erste Fassung", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateRepresentation(Representation{AssetVersionID: v.ID, Type: "source", Storage: StorageLocation{Provider: "filesystem", URI: "/x/" + title + ".mxf"}}); err != nil {
		t.Fatal(err)
	}
	a, _ = s.GetAsset(a.ID)
	return a
}

func TestPurgeDeletedRemovesOnlyDeletedWithVersionsAndRepresentations(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)
	keep := deleteAsset(t, s, "bleibt")
	gone := deleteAsset(t, s, "weg")
	gone, err := s.UpdateAssetStatus(gone.ID, gone.RowVersion, StatusDeleted, "alice")
	if err != nil {
		t.Fatal(err)
	}
	var hookCalls, afterCalls int
	RegisterPurgeHook("test", func(tx *sql.Tx, ids []string) (func(), error) {
		hookCalls++
		if len(ids) != 1 || ids[0] != gone.ID {
			t.Errorf("Haken bekam %v, erwartet nur %s", ids, gone.ID)
		}
		return func() { afterCalls++ }, nil
	})
	defer RegisterPurgeHook("test", func(*sql.Tx, []string) (func(), error) { return nil, nil })

	// Frist noch nicht erreicht: nichts passiert
	if ids, err := s.PurgeDeleted(24 * time.Hour); err != nil || len(ids) != 0 || hookCalls != 0 {
		t.Fatalf("mit Frist: ids=%v err=%v hook=%d", ids, err, hookCalls)
	}
	ids, err := s.PurgeDeleted(0)
	if err != nil || len(ids) != 1 || ids[0] != gone.ID {
		t.Fatalf("PurgeDeleted = %v, %v", ids, err)
	}
	if hookCalls != 1 || afterCalls != 1 {
		t.Errorf("Haken: %d, nach Commit: %d", hookCalls, afterCalls)
	}
	if _, err := s.GetAsset(gone.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("gelöschtes Asset existiert noch: %v", err)
	}
	var versions, reps int
	_ = db.QueryRow(`SELECT count(*) FROM asset_versions WHERE asset_id = $1`, gone.ID).Scan(&versions)
	_ = db.QueryRow(`SELECT count(*) FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id WHERE v.asset_id = $1`, gone.ID).Scan(&reps)
	if versions != 0 || reps != 0 {
		t.Errorf("Waisen: %d Versionen, %d Darstellungen", versions, reps)
	}
	if _, err := s.GetAsset(keep.ID); err != nil {
		t.Errorf("nicht gelöschtes Asset fehlt: %v", err)
	}
	// zweiter Lauf: nichts mehr zu tun
	if ids, _ := s.PurgeDeleted(0); len(ids) != 0 {
		t.Errorf("zweiter Lauf: %v", ids)
	}
}

func TestPurgeDeletedRollsBackWhenAHookFails(t *testing.T) {
	s := NewStore(testDB(t))
	a := deleteAsset(t, s, "bleibt-bei-fehler")
	a, _ = s.UpdateAssetStatus(a.ID, a.RowVersion, StatusDeleted, "alice")
	RegisterPurgeHook("kaputt", func(*sql.Tx, []string) (func(), error) { return nil, errors.New("boom") })
	defer RegisterPurgeHook("kaputt", func(*sql.Tx, []string) (func(), error) { return nil, nil })
	if _, err := s.PurgeDeleted(0); err == nil {
		t.Fatal("Fehler des Hakens muss durchschlagen")
	}
	if _, err := s.GetAsset(a.ID); err != nil {
		t.Fatalf("Asset muss nach Fehler erhalten bleiben: %v", err)
	}
}

package asset

import (
	"database/sql"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/outbox"
)

// TestStoreWithoutOutboxOptionPublishesNothing belegt die Nicht-
// Regression: ein Store ohne WithOutbox() verhält sich exakt wie vor
// der B9-Integration (kein outbox_events-Schreibzugriff).
func TestStoreWithoutOutboxOptionPublishesNothing(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	a, err := s.CreateAsset("VIDEO", "Clip", "", "alice")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}
	if got := assetEventSubjects(t, db, a.ID); len(got) != 0 {
		t.Fatalf("outbox events for asset = %v, want none (no outbox.Store configured)", got)
	}
}

func TestStoreWithOutboxPublishesLifecycleEvents(t *testing.T) {
	db := testDB(t)
	ob := outbox.NewStore(db)
	s := NewStore(db, WithOutbox(ob))

	a, err := s.CreateAsset("VIDEO", "Clip", "", "alice")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}
	registered, err := s.UpdateAssetStatus(a.ID, a.RowVersion, StatusRegistered, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetStatus() error = %v", err)
	}
	if _, err := s.UpdateAssetMetadata(a.ID, registered.RowVersion, Metadata{Descriptive: map[string]any{"title": "x"}}, "alice"); err != nil {
		t.Fatalf("UpdateAssetMetadata() error = %v", err)
	}
	v, err := s.CreateVersion(a.ID, "", "initial", "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	if _, err := s.PublishVersion(v.ID); err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}

	subjects := assetEventSubjects(t, db, a.ID)

	wantSubjects := []string{
		eventSubject(a.ID, "created"),
		eventSubject(a.ID, "registered"),
		eventSubject(a.ID, "metadata_updated"),
		eventSubject(a.ID, "version_created"),
		eventSubject(a.ID, "version_published"),
	}
	got := map[string]bool{}
	for _, subj := range subjects {
		got[subj] = true
	}
	for _, want := range wantSubjects {
		if !got[want] {
			t.Errorf("missing outbox event with subject %q, got subjects %v", want, subjects)
		}
	}
	if len(subjects) != len(wantSubjects) {
		t.Errorf("outbox events for asset = %d, want exactly %d: %v", len(subjects), len(wantSubjects), subjects)
	}
}

// TestOutboxEventRolledBackOnConcurrentModification belegt die
// Atomaritäts-Garantie in die andere Richtung: schlägt der State-Change
// selbst fehl (hier: CAS-Konflikt), darf NIE ein Event dafür entstehen.
func TestOutboxEventRolledBackOnConcurrentModification(t *testing.T) {
	db := testDB(t)
	ob := outbox.NewStore(db)
	s := NewStore(db, WithOutbox(ob))

	a, err := s.CreateAsset("VIDEO", "Clip", "", "alice")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}
	// "created" ist schon in der Outbox — für diesen Test relevant ist
	// nur, dass ein FEHLSCHLAGENDER Übergang KEIN weiteres Event erzeugt.
	staleRowVersion := a.RowVersion + 99
	if _, err := s.UpdateAssetStatus(a.ID, staleRowVersion, StatusRegistered, "alice"); err != ErrConcurrentModification {
		t.Fatalf("UpdateAssetStatus() with stale rowVersion error = %v, want ErrConcurrentModification", err)
	}

	if subjects := assetEventSubjects(t, db, a.ID); len(subjects) != 1 || subjects[0] != eventSubject(a.ID, "created") {
		t.Fatalf("outbox events for asset = %v, want only the 'created' event from CreateAsset (the failed UpdateAssetStatus must not have enqueued anything)", subjects)
	}
}

// assetEventSubjects liest die Outbox-Events GENAU dieses Assets —
// unabhängig davon, ob sie schon versendet wurden. Alle Pakete teilen
// sich eine Testdatenbank (internal/dbtest) und `go test ./...` läuft
// paketparallel: der Relay-Test in internal/outbox versendet dabei ALLE
// offenen Events der Tabelle, auch die dieses Pakets. Die früheren
// Prüfungen über Undispatched() plus ein globales DELETE FROM
// outbox_events waren deshalb in beide Richtungen flaky (Nachtrag 270).
func assetEventSubjects(t *testing.T, db *sql.DB, assetID string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT subject FROM outbox_events WHERE subject LIKE $1 ORDER BY created_at, id`, "omp.asset."+assetID+".%")
	if err != nil {
		t.Fatalf("query outbox_events: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var subj string
		if err := rows.Scan(&subj); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, subj)
	}
	return out
}

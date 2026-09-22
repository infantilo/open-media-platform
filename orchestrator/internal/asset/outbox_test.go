package asset

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/outbox"
)

// TestStoreWithoutOutboxOptionPublishesNothing belegt die Nicht-
// Regression: ein Store ohne WithOutbox() verhält sich exakt wie vor
// der B9-Integration (kein outbox_events-Schreibzugriff).
func TestStoreWithoutOutboxOptionPublishesNothing(t *testing.T) {
	db := testDB(t)
	if _, err := db.Exec(`DELETE FROM outbox_events`); err != nil {
		t.Fatalf("cleanup outbox_events: %v", err)
	}
	s := NewStore(db)

	if _, err := s.CreateAsset("VIDEO", "Clip", "", "alice"); err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}

	ob := outbox.NewStore(db)
	undispatched, err := ob.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 0 {
		t.Fatalf("Undispatched() = %+v, want none (no outbox.Store configured)", undispatched)
	}
}

func TestStoreWithOutboxPublishesLifecycleEvents(t *testing.T) {
	db := testDB(t)
	if _, err := db.Exec(`DELETE FROM outbox_events`); err != nil {
		t.Fatalf("cleanup outbox_events: %v", err)
	}
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

	undispatched, err := ob.Undispatched(20)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}

	wantSubjects := []string{
		eventSubject(a.ID, "created"),
		eventSubject(a.ID, "registered"),
		eventSubject(a.ID, "metadata_updated"),
		eventSubject(a.ID, "version_created"),
		eventSubject(a.ID, "version_published"),
	}
	got := map[string]bool{}
	for _, e := range undispatched {
		got[e.Subject] = true
	}
	for _, want := range wantSubjects {
		if !got[want] {
			t.Errorf("missing outbox event with subject %q, got subjects %v", want, subjectsOf(undispatched))
		}
	}
	if len(undispatched) != len(wantSubjects) {
		t.Errorf("Undispatched() = %d events, want exactly %d: %v", len(undispatched), len(wantSubjects), subjectsOf(undispatched))
	}
}

// TestOutboxEventRolledBackOnConcurrentModification belegt die
// Atomaritäts-Garantie in die andere Richtung: schlägt der State-Change
// selbst fehl (hier: CAS-Konflikt), darf NIE ein Event dafür entstehen.
func TestOutboxEventRolledBackOnConcurrentModification(t *testing.T) {
	db := testDB(t)
	if _, err := db.Exec(`DELETE FROM outbox_events`); err != nil {
		t.Fatalf("cleanup outbox_events: %v", err)
	}
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

	undispatched, err := ob.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 1 || undispatched[0].Subject != eventSubject(a.ID, "created") {
		t.Fatalf("Undispatched() = %v, want only the 'created' event from CreateAsset (the failed UpdateAssetStatus must not have enqueued anything)", subjectsOf(undispatched))
	}
}

func subjectsOf(events []outbox.Event) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.Subject
	}
	return out
}

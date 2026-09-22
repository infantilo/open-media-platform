package outbox

import (
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

// testDB liefert eine migrierte, isolierte Testdatenbank — niemals die
// echte Dev-Postgres (dbtest.Open, docs/decisions.md Nachtrag 108).
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM outbox_events`); err != nil {
			t.Fatalf("cleanup outbox_events: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func TestEnqueueRequiresTransaction(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	e, err := s.Enqueue(tx, "omp.asset.a1.created", json.RawMessage(`{"assetId":"a1"}`), "dedup-1")
	if err != nil {
		t.Fatalf("Enqueue() error = %v", err)
	}
	if e.ID == "" {
		t.Fatalf("Enqueue() = %+v, want non-empty ID", e)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit() error = %v", err)
	}

	undispatched, err := s.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 1 || undispatched[0].ID != e.ID {
		t.Fatalf("Undispatched() = %+v, want exactly [%s]", undispatched, e.ID)
	}
}

func TestEnqueueRolledBackTransactionNeverPersists(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	if _, err := s.Enqueue(tx, "omp.asset.a1.created", json.RawMessage(`{}`), ""); err != nil {
		t.Fatalf("Enqueue() error = %v", err)
	}
	// Genau die Atomaritäts-Garantie, die das Outbox-Muster verspricht:
	// ein Rollback der begleitenden Transaktion darf das Event NIE
	// sichtbar machen (kein "Phantom-Event" für einen nie committeten
	// State-Change).
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback() error = %v", err)
	}

	undispatched, err := s.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 0 {
		t.Fatalf("Undispatched() = %+v, want none (transaction was rolled back)", undispatched)
	}
}

func TestEnqueueDB(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	e, err := s.EnqueueDB("omp.process.exec1.completed", json.RawMessage(`{}`), "")
	if err != nil {
		t.Fatalf("EnqueueDB() error = %v", err)
	}
	undispatched, err := s.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 1 || undispatched[0].ID != e.ID {
		t.Fatalf("Undispatched() = %+v, want exactly [%s]", undispatched, e.ID)
	}
}

func TestUndispatchedRespectsLimitAndOrder(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	var ids []string
	for i := 0; i < 3; i++ {
		e, err := s.EnqueueDB("omp.test.event", json.RawMessage(`{}`), "")
		if err != nil {
			t.Fatalf("EnqueueDB() error = %v", err)
		}
		ids = append(ids, e.ID)
	}

	limited, err := s.Undispatched(2)
	if err != nil {
		t.Fatalf("Undispatched(2) error = %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("Undispatched(2) = %d entries, want 2", len(limited))
	}
	if limited[0].ID != ids[0] || limited[1].ID != ids[1] {
		t.Errorf("Undispatched(2) = %+v, want oldest-first %v", limited, ids[:2])
	}
}

func TestMarkDispatchedIsIdempotent(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)

	e, err := s.EnqueueDB("omp.test.event", json.RawMessage(`{}`), "")
	if err != nil {
		t.Fatalf("EnqueueDB() error = %v", err)
	}
	if err := s.MarkDispatched(e.ID); err != nil {
		t.Fatalf("MarkDispatched() error = %v", err)
	}
	// Zweiter Aufruf mit derselben ID: kein Fehler (Relay-Neustart nach
	// erfolgreichem, aber noch nicht quittiertem Publish).
	if err := s.MarkDispatched(e.ID); err != nil {
		t.Fatalf("MarkDispatched() (2nd) error = %v, want nil (idempotent)", err)
	}

	undispatched, err := s.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 0 {
		t.Fatalf("Undispatched() = %+v, want none (already dispatched)", undispatched)
	}
}

func TestMarkDispatchedUnknownIDReturnsNotFound(t *testing.T) {
	db := testDB(t)
	s := NewStore(db)
	if err := s.MarkDispatched("does-not-exist"); err != ErrNotFound {
		t.Fatalf("MarkDispatched() error = %v, want ErrNotFound", err)
	}
}

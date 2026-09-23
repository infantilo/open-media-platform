package domainaudit

import (
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher — s. internal/audit_test.go (identisches Muster).
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	// Isolierte Testdatenbank je Paket (Nachtrag 270, s. internal/dbtest)
	// — kein impliziter Fallback auf die echte Dev-DB (Nachtrag 108).
	return dbtest.Open(t)
}

func TestLogAndList(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	actor := "test-domainaudit-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	store.Log(actor, "asset", "asset-1", "created", map[string]any{"title": "Beispiel"})
	store.Log(actor, "human_task", "task-1", "completed", map[string]any{"decision": "approved", "comment": "ok"})

	entries, err := store.List(0, 100)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	found := 0
	for _, e := range entries {
		if e.Actor != actor {
			continue
		}
		found++
		switch e.Action {
		case "created":
			if e.ObjectType != "asset" || e.ObjectID != "asset-1" {
				t.Errorf("created entry = %+v, unexpected", e)
			}
			var details map[string]string
			if err := json.Unmarshal(e.Details, &details); err != nil || details["title"] != "Beispiel" {
				t.Errorf("created entry details = %s, want title=Beispiel", e.Details)
			}
		case "completed":
			if e.ObjectType != "human_task" || e.ObjectID != "task-1" {
				t.Errorf("completed entry = %+v, unexpected", e)
			}
			var details map[string]string
			if err := json.Unmarshal(e.Details, &details); err != nil || details["decision"] != "approved" {
				t.Errorf("completed entry details = %s, want decision=approved", e.Details)
			}
		default:
			t.Errorf("unexpected action %q", e.Action)
		}
	}
	if found != 2 {
		t.Fatalf("List() found %d entries for %s, want 2", found, actor)
	}
}

// TestLogWithNilDetailsStoresEmptyObject — details darf nil sein (kein
// Sonderfall für den Aufrufer nötig), muss aber als gültiges JSON-Objekt
// ankommen, nicht NULL (vereinfacht das Lesen).
func TestLogWithNilDetailsStoresEmptyObject(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	actor := "test-domainaudit-nildetails"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	store.Log(actor, "process_definition", "def-1", "created", nil)

	entries, err := store.ListByObject("process_definition", "def-1", 10)
	if err != nil {
		t.Fatalf("ListByObject() error = %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("ListByObject() found %d entries, want 1", len(entries))
	}
	if string(entries[0].Details) != "{}" {
		t.Errorf("Details = %s, want {}", entries[0].Details)
	}
}

func TestListByObjectOnlyReturnsMatchingObject(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	actor := "test-domainaudit-byobject"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	store.Log(actor, "asset", "asset-a", "created", nil)
	store.Log(actor, "asset", "asset-a", "status_changed", map[string]any{"from": "eingang", "to": "registriert"})
	store.Log(actor, "asset", "asset-b", "created", nil)

	entries, err := store.ListByObject("asset", "asset-a", 10)
	if err != nil {
		t.Fatalf("ListByObject() error = %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("ListByObject() found %d entries, want 2", len(entries))
	}
	// Neueste zuerst.
	if entries[0].Action != "status_changed" || entries[1].Action != "created" {
		t.Errorf("order = [%s, %s], want [status_changed, created]", entries[0].Action, entries[1].Action)
	}
}

func TestLogBroadcastsDomainAuditAppended(t *testing.T) {
	database := testDB(t)
	pub := &fakeEventPublisher{}
	store := NewStore(database, pub)
	actor := "test-domainaudit-broadcast-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	store.Log(actor, "asset", "asset-1", "created", nil)

	if len(pub.types) != 1 || pub.types[0] != "domainAudit.appended" {
		t.Errorf("published events = %v, want [domainAudit.appended]", pub.types)
	}
}

// TestListCursorPaginatesThroughAllEntries — s. internal/audit_test.go
// (identisches Muster, andere Tabelle).
func TestListCursorPaginatesThroughAllEntries(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	actor := "test-domainaudit-pagination-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	var existingCount int
	if err := database.QueryRow(`SELECT count(*) FROM domain_audit_log`).Scan(&existingCount); err != nil {
		t.Fatalf("count(*) error = %v", err)
	}

	const total = 25
	for i := 0; i < total; i++ {
		store.Log(actor, "asset", "asset-pagination", "touched", nil)
	}

	maxPages := (existingCount+total)/10 + 5

	seen := map[int64]bool{}
	var before int64
	var lastID int64 = 1<<63 - 1
	pages := 0
	for {
		page, err := store.List(before, 10)
		if err != nil {
			t.Fatalf("List() error = %v", err)
		}
		pages++
		if pages > maxPages {
			t.Fatalf("too many pages (%d, cap %d based on %d existing + %d new rows), pagination likely stuck in a loop", pages, maxPages, existingCount, total)
		}
		if len(page) == 0 {
			break
		}
		for _, e := range page {
			before = e.ID
			if e.Actor != actor {
				continue
			}
			if seen[e.ID] {
				t.Fatalf("id %d seen twice across pages — cursor overlap", e.ID)
			}
			seen[e.ID] = true
			if e.ID >= lastID {
				t.Fatalf("id %d not strictly decreasing after previous id %d — wrong order", e.ID, lastID)
			}
			lastID = e.ID
		}
		if len(page) < 10 {
			break
		}
	}

	if len(seen) != total {
		t.Fatalf("saw %d unique entries across pages, want %d", len(seen), total)
	}
}

func TestPurgeOlderThanDeletesOnlyOldRows(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	oldActor := "test-domainaudit-retention-old"
	freshActor := "test-domainaudit-retention-fresh"
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor IN ($1, $2)`, oldActor, freshActor)
	})

	store.Log(oldActor, "asset", "asset-old", "created", nil)
	store.Log(freshActor, "asset", "asset-fresh", "created", nil)

	if _, err := database.Exec(
		`UPDATE domain_audit_log SET occurred_at = now() - interval '100 days' WHERE actor = $1`, oldActor,
	); err != nil {
		t.Fatalf("artificially age the old row: %v", err)
	}

	deleted, err := store.PurgeOlderThan(90)
	if err != nil {
		t.Fatalf("PurgeOlderThan() error = %v", err)
	}
	if deleted < 1 {
		t.Errorf("PurgeOlderThan() deleted = %d, want at least 1 (the artificially aged row)", deleted)
	}

	entries, err := store.List(0, 1000)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	for _, e := range entries {
		if e.Actor == oldActor {
			t.Errorf("old row (actor=%s) still present after PurgeOlderThan(90)", oldActor)
		}
	}
	foundFresh := false
	for _, e := range entries {
		if e.Actor == freshActor {
			foundFresh = true
		}
	}
	if !foundFresh {
		t.Error("fresh row was deleted too — PurgeOlderThan(90) should only remove rows older than 90 days")
	}
}

func TestPurgeOlderThanZeroOrNegativeIsNoOp(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	actor := "test-domainaudit-retention-noop"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM domain_audit_log WHERE actor = $1`, actor) })

	store.Log(actor, "asset", "asset-noop", "created", nil)
	if _, err := database.Exec(
		`UPDATE domain_audit_log SET occurred_at = now() - interval '1000 days' WHERE actor = $1`, actor,
	); err != nil {
		t.Fatalf("artificially age the row: %v", err)
	}

	if _, err := store.PurgeOlderThan(0); err != nil {
		t.Fatalf("PurgeOlderThan(0) error = %v", err)
	}

	entries, err := store.List(0, 1000)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Actor == actor {
			found = true
		}
	}
	if !found {
		t.Error("row was deleted despite retentionDays=0 (should be a no-op)")
	}
}

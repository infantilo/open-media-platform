package audit

import (
	"database/sql"
	"os"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher ist ein Test-Double für EventPublisher, das nur die
// Typen der empfangenen Events sammelt (gleiches Muster wie
// graph_test.go).
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("OMP_POSTGRES_URL")
	if dsn == "" {
		dsn = "postgres://omp:omp@localhost:5432/omp?sslmode=disable"
	}
	database, err := db.Connect(dsn)
	if err != nil {
		t.Skipf("postgres nicht erreichbar (%v) — für diesen Test `make up` starten", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestLogAndList(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	username := "test-audit-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	store.Log(username, "PATCH", "/api/v1/nodes/n1/params/gain", "inst-mixer", 200)
	store.Log(username, "POST", "/api/v1/graph/edges", "", 403)

	entries, err := store.List(0, 100)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	found := 0
	for _, e := range entries {
		if e.Username != username {
			continue
		}
		found++
		if e.Method == "PATCH" && (e.NodeID != "inst-mixer" || e.Status != 200) {
			t.Errorf("PATCH entry = %+v, unexpected", e)
		}
		if e.Method == "POST" && (e.NodeID != "" || e.Status != 403) {
			t.Errorf("POST entry = %+v, unexpected", e)
		}
	}
	if found != 2 {
		t.Fatalf("List() found %d entries for %s, want 2", found, username)
	}
}

func TestLogBroadcastsAuditAppended(t *testing.T) {
	database := testDB(t)
	pub := &fakeEventPublisher{}
	store := NewStore(database, pub)
	username := "test-audit-broadcast-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	store.Log(username, "POST", "/api/v1/workflows", "", 201)

	if len(pub.types) != 1 || pub.types[0] != "audit.appended" {
		t.Errorf("published events = %v, want [audit.appended]", pub.types)
	}
}

// TestListCursorPaginatesThroughAllEntries ist die S5-Kern-Verifikation
// (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): "Mehr laden" muss über
// mehrere Seiten hinweg jeden Eintrag genau einmal liefern, neueste
// zuerst, und am Ende eine kürzere Seite als limit signalisieren.
func TestListCursorPaginatesThroughAllEntries(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	username := "test-audit-pagination-user"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	const total = 25
	for i := 0; i < total; i++ {
		store.Log(username, "GET", "/api/v1/pagination-test", "", 200)
	}

	seen := map[int64]bool{}
	var before int64
	var lastID int64 = 1<<63 - 1 // größter möglicher int64, für die Monotonie-Prüfung unten
	pages := 0
	for {
		page, err := store.List(before, 10)
		if err != nil {
			t.Fatalf("List() error = %v", err)
		}
		pages++
		if pages > 200 {
			t.Fatal("too many pages, pagination likely stuck in a loop")
		}
		if len(page) == 0 {
			break
		}
		for _, e := range page {
			// Cursor über ALLE Zeilen fortschreiben, nicht nur die zu
			// diesem Test gehörenden — sonst gibt es keinen Fortschritt
			// (Endlosschleife), sobald eine Seite überwiegend aus
			// Audit-Zeilen anderer Testläufe/Sessions besteht (dieselbe
			// Tabelle wird geteilt, kein isoliertes Test-Schema).
			before = e.ID
			if e.Username != username {
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
			break // letzte Seite erreicht
		}
	}

	if len(seen) != total {
		t.Fatalf("saw %d unique entries across pages, want %d", len(seen), total)
	}
}

// TestPurgeOlderThanDeletesOnlyOldRows ist die S5-Retention-Verifikation.
func TestPurgeOlderThanDeletesOnlyOldRows(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	oldUsername := "test-audit-retention-old"
	freshUsername := "test-audit-retention-fresh"
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM audit_log WHERE username IN ($1, $2)`, oldUsername, freshUsername)
	})

	store.Log(oldUsername, "GET", "/api/v1/retention-test", "", 200)
	store.Log(freshUsername, "GET", "/api/v1/retention-test", "", 200)

	if _, err := database.Exec(
		`UPDATE audit_log SET occurred_at = now() - interval '100 days' WHERE username = $1`, oldUsername,
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
		if e.Username == oldUsername {
			t.Errorf("old row (username=%s) still present after PurgeOlderThan(90)", oldUsername)
		}
	}
	foundFresh := false
	for _, e := range entries {
		if e.Username == freshUsername {
			foundFresh = true
		}
	}
	if !foundFresh {
		t.Error("fresh row was deleted too — PurgeOlderThan(90) should only remove rows older than 90 days")
	}
}

// TestPurgeOlderThanZeroOrNegativeIsNoOp — retentionDays <= 0
// deaktiviert die Löschung statt überraschend alles zu löschen.
func TestPurgeOlderThanZeroOrNegativeIsNoOp(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	username := "test-audit-retention-noop"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	store.Log(username, "GET", "/api/v1/retention-noop-test", "", 200)
	if _, err := database.Exec(
		`UPDATE audit_log SET occurred_at = now() - interval '1000 days' WHERE username = $1`, username,
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
		if e.Username == username {
			found = true
		}
	}
	if !found {
		t.Error("row was deleted despite retentionDays=0 (should be a no-op)")
	}
}

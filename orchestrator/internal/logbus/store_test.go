package logbus

import (
	"database/sql"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher — gleiches Test-Double-Muster wie audit_test.go/
// graph_test.go.
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }

func cleanLogs(t *testing.T, database *sql.DB) {
	t.Helper()
	clean := func() { _, _ = database.Exec(`DELETE FROM logs`) }
	clean()
	t.Cleanup(clean)
}

func TestInsertAndQueryByTraceID(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	events := &fakeEventPublisher{}
	store := NewStore(database, events)

	if err := store.Insert(Entry{Level: "warn", Message: "is05 patch failed", TraceID: "trace-1", NodeID: "node-a", Source: "orchestrator"}); err != nil {
		t.Fatalf("Insert() error = %v", err)
	}
	if err := store.Insert(Entry{Level: "info", Message: "unrelated", TraceID: "trace-2", NodeID: "node-b", Source: "orchestrator"}); err != nil {
		t.Fatalf("Insert() error = %v", err)
	}

	entries, err := store.Query(Filter{TraceID: "trace-1"})
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("Query(TraceID=trace-1) returned %d entries, want 1", len(entries))
	}
	if entries[0].Message != "is05 patch failed" {
		t.Errorf("Message = %q, want %q", entries[0].Message, "is05 patch failed")
	}
	if entries[0].NodeID != "node-a" {
		t.Errorf("NodeID = %q, want %q", entries[0].NodeID, "node-a")
	}

	if len(events.types) != 2 || events.types[0] != "log.appended" {
		t.Errorf("events.types = %v, want two \"log.appended\" broadcasts", events.types)
	}
}

func TestQueryFiltersByNodeIDAndLevel(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	store := NewStore(database, nil)

	_ = store.Insert(Entry{Level: "error", Message: "a", NodeID: "node-x", Source: "orchestrator"})
	_ = store.Insert(Entry{Level: "info", Message: "b", NodeID: "node-x", Source: "orchestrator"})
	_ = store.Insert(Entry{Level: "error", Message: "c", NodeID: "node-y", Source: "orchestrator"})

	entries, err := store.Query(Filter{NodeID: "node-x", Level: "error"})
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Message != "a" {
		t.Fatalf("Query(node-x, error) = %+v, want exactly entry \"a\"", entries)
	}
}

func TestQueryOrdersNewestFirstAndRespectsBeforeCursor(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	store := NewStore(database, nil)

	for _, msg := range []string{"first", "second", "third"} {
		if err := store.Insert(Entry{Level: "info", Message: msg, Source: "orchestrator"}); err != nil {
			t.Fatalf("Insert() error = %v", err)
		}
	}

	all, err := store.Query(Filter{})
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(all) != 3 || all[0].Message != "third" || all[2].Message != "first" {
		t.Fatalf("Query() = %+v, want newest-first [third, second, first]", all)
	}

	before, err := store.Query(Filter{Before: all[0].ID})
	if err != nil {
		t.Fatalf("Query(Before) error = %v", err)
	}
	if len(before) != 2 || before[0].Message != "second" {
		t.Fatalf("Query(Before=%d) = %+v, want [second, first]", all[0].ID, before)
	}
}

func TestPurgeOlderThanDisabledWhenNonPositive(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	store := NewStore(database, nil)
	_ = store.Insert(Entry{Level: "info", Message: "old", Source: "orchestrator"})

	deleted, err := store.PurgeOlderThan(0)
	if err != nil {
		t.Fatalf("PurgeOlderThan(0) error = %v", err)
	}
	if deleted != 0 {
		t.Errorf("PurgeOlderThan(0) deleted = %d, want 0 (disabled)", deleted)
	}
}

func TestPurgeOlderThanDeletesOldRows(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	store := NewStore(database, nil)

	_, err := database.Exec(
		`INSERT INTO logs (occurred_at, level, message, source) VALUES ($1, 'info', 'ancient', 'orchestrator')`,
		time.Now().Add(-100*time.Hour))
	if err != nil {
		t.Fatalf("seed insert error = %v", err)
	}
	if err := store.Insert(Entry{Level: "info", Message: "fresh", Source: "orchestrator"}); err != nil {
		t.Fatalf("Insert() error = %v", err)
	}

	deleted, err := store.PurgeOlderThan(72)
	if err != nil {
		t.Fatalf("PurgeOlderThan(72) error = %v", err)
	}
	if deleted != 1 {
		t.Fatalf("PurgeOlderThan(72) deleted = %d, want 1", deleted)
	}

	remaining, err := store.Query(Filter{})
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(remaining) != 1 || remaining[0].Message != "fresh" {
		t.Fatalf("Query() after purge = %+v, want only \"fresh\"", remaining)
	}
}

func TestQueryTextLevelsAndSummaryGrouping(t *testing.T) {
	database := dbtest.Open(t)
	cleanLogs(t, database)
	store := NewStore(database, nil)

	_ = store.Insert(Entry{Level: "warn", Message: "node proxy call failed (GET /params/gain): dial tcp 127.0.0.1:41199: refused", NodeID: "node-a", Source: "orchestrator"})
	_ = store.Insert(Entry{Level: "error", Message: "node proxy call failed (GET /params/gain): dial tcp 127.0.0.1:39283: refused", NodeID: "node-b", Source: "orchestrator"})
	_ = store.Insert(Entry{Level: "warn", Message: "something else", Source: "orchestrator"})

	es, err := store.Query(Filter{Query: "PROXY CALL", Levels: []string{"error", "warn"}})
	if err != nil || len(es) != 2 {
		t.Fatalf("text+levels query = %d entries, err %v, want 2", len(es), err)
	}
	es, _ = store.Query(Filter{Query: "100%"})
	if len(es) != 0 {
		t.Errorf("LIKE wildcard must be escaped, got %d entries", len(es))
	}

	groups, err := store.Summary(Filter{}, 10)
	if err != nil {
		t.Fatalf("Summary() error = %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("Summary() = %d groups, want 2 (ports/ids normalised)", len(groups))
	}
	var proxy Group
	for _, g := range groups {
		if g.Count == 2 {
			proxy = g
		}
	}
	if proxy.Count != 2 || proxy.Level != "error" || len(proxy.NodeIDs) != 2 {
		t.Fatalf("proxy group = %+v, want count 2, level error, 2 nodes", proxy)
	}
	// MsgKey führt von der Gruppe zurück zu den Einzelmeldungen.
	es, _ = store.Query(Filter{MsgKey: proxy.Key})
	if len(es) != 2 {
		t.Errorf("Query(MsgKey) = %d entries, want 2", len(es))
	}
}

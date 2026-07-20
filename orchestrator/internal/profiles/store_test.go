package profiles

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

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

func TestStoreUpsertAndGet(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM node_type_profiles WHERE node_type = 'test-profiles-store'`)
	})

	ctx := context.Background()
	snap := Snapshot{
		NodeType: "test-profiles-store", HostID: "host-x",
		CPUMin: 5, CPUAvg: 15, CPUMax: 30, CPUP95: 28,
		RSSMin: 1_000_000, RSSAvg: 2_000_000, RSSMax: 3_000_000,
		SampleCount: 12, UpdatedAt: time.Now().Truncate(time.Second),
	}
	if err := store.Upsert(ctx, snap); err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}

	got, ok, err := store.Get(ctx, "test-profiles-store", "host-x")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if !ok {
		t.Fatalf("Get() ok = false, want true")
	}
	if got.CPUAvg != 15 || got.CPUP95 != 28 || got.RSSAvg != 2_000_000 || got.SampleCount != 12 {
		t.Errorf("Get() = %+v, unexpected", got)
	}

	// Upsert überschreibt vollständig statt zu mergen.
	snap.CPUAvg = 99
	snap.SampleCount = 1
	if err := store.Upsert(ctx, snap); err != nil {
		t.Fatalf("second Upsert() error = %v", err)
	}
	got, ok, err = store.Get(ctx, "test-profiles-store", "host-x")
	if err != nil || !ok {
		t.Fatalf("Get() after second upsert: ok=%v, error=%v", ok, err)
	}
	if got.CPUAvg != 99 || got.SampleCount != 1 {
		t.Errorf("Upsert() did not overwrite, got %+v", got)
	}
}

func TestStoreGetUnknownReturnsNotOk(t *testing.T) {
	database := testDB(t)
	store := NewStore(database)

	_, ok, err := store.Get(context.Background(), "test-profiles-store-ghost-type", "host-x")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if ok {
		t.Errorf("Get() ok = true for a never-written profile, want false")
	}
}

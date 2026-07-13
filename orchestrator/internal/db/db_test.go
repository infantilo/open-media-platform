package db

import (
	"database/sql"
	"os"
	"testing"
)

// testDSN liefert die Postgres-DSN für Tests: OMP_POSTGRES_URL falls
// gesetzt (gleiche Variable wie die Orchestrator-Konfiguration, config.go),
// sonst dieselbe lokale Dev-Default-DSN. Tests, die eine echte Postgres-
// Instanz brauchen, überspringen sich selbst (t.Skip), wenn sie nicht
// erreichbar ist — kein Postgres-Mock (SQL-Korrektheit ist ohne echte DB
// nicht sinnvoll prüfbar), aber auch kein harter CI-/Dev-Zwang, immer
// eine laufende Instanz zu haben (`make up` startet sie, docs/decisions.md
// D1).
func testDSN() string {
	if v := os.Getenv("OMP_POSTGRES_URL"); v != "" {
		return v
	}
	return "postgres://omp:omp@localhost:5432/omp?sslmode=disable"
}

func connectOrSkip(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Connect(testDSN())
	if err != nil {
		t.Skipf("postgres nicht erreichbar (%v) — für diesen Test `make up` starten", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMigrateCreatesTablesAndIsIdempotent(t *testing.T) {
	database := connectOrSkip(t)

	if err := Migrate(database); err != nil {
		t.Fatalf("Migrate() first run error = %v", err)
	}
	// Zweiter Lauf muss ohne Fehler durchgehen (schon angewendete
	// Migrationen werden übersprungen) — das ist der eigentliche Zweck
	// von schema_migrations.
	if err := Migrate(database); err != nil {
		t.Fatalf("Migrate() second run error = %v", err)
	}

	for _, table := range []string{"layouts", "snapshots", "schema_migrations"} {
		var exists bool
		err := database.QueryRow(
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`, table,
		).Scan(&exists)
		if err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s does not exist after Migrate()", table)
		}
	}
}

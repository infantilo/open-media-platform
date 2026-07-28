package db

import (
	"database/sql"
	"os"
	"testing"
)

// connectOrSkip verbindet für Tests, die eine echte Postgres-Instanz
// brauchen — ausschließlich über OMP_POSTGRES_URL, kein impliziter
// Fallback auf die lokale Dev-Default-DSN mehr (Nachtrag 108,
// docs/decisions.md): dieser Fallback verband sich bei fehlendem
// OMP_POSTGRES_URL unbemerkt mit der echten, dauerhaft laufenden
// Dev-Postgres und führte in anderen Paketen (workflows, snapshots, …)
// zu echtem Datenverlust, weil deren Tests danach `DELETE FROM ...`
// gegen genau diese Verbindung ausführen. Wer diese Tests laufen lassen
// will, muss OMP_POSTGRES_URL jetzt explizit selbst setzen.
func connectOrSkip(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("OMP_POSTGRES_URL")
	if dsn == "" {
		t.Skip("OMP_POSTGRES_URL nicht gesetzt — DB-Test übersprungen (kein impliziter Fallback mehr, s. docs/decisions.md Nachtrag 108)")
	}
	db, err := Connect(dsn)
	if err != nil {
		t.Skipf("postgres nicht erreichbar (%v)", err)
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

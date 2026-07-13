// Package db verbindet den Orchestrator mit PostgreSQL (UMSETZUNG.md D1,
// ARCHITECTURE.md §4.4) und wendet Schema-Migrationen an — Grundlage für
// layouts.Store/snapshots.Store, die ab D1 SQL statt Dateien nutzen.
//
// Bewusst kein Migrations-Framework (golang-migrate/goose o. Ä.): die
// Minimal-Dependency-Regel (UMSETZUNG.md §0 Punkt 5) verlangt eine
// Begründung vor jedem `go get` — für den hier gebrauchten Umfang (ein
// paar sequenzielle .sql-Dateien, kein Down-Migrations-Bedarf, kein
// Multi-DB-Support) wäre ein Framework Overhead ohne Gegenwert. `lib/pq`
// selbst ist die eine, unvermeidbare Ausnahme (reiner Postgres-
// Wire-Protocol-Treiber für `database/sql`, keine eigenen
// Transitiv-Abhängigkeiten) — dieselbe Kategorie Ausnahme wie
// `nats.go` in `internal/eventbus` (docs/decisions.md, Schritt A6).
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"

	_ "github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// migrationLockKey ist ein für dieses Projekt fest gewählter
// `pg_advisory_lock`-Schlüssel (beliebige, aber stabile int64-Zahl —
// kein Bezug zu Daten, nur Namensraum-Trennung falls dieselbe Postgres-
// Instanz später weitere, unabhängig gelockte Anwendungen bedient).
// Serialisiert `Migrate()` über parallele Aufrufer hinweg (mehrere
// Orchestrator-Prozesse, aber auch mehrere Go-Testpakete, die dieselbe
// Dev-Datenbank verwenden — `go test ./...` startet jedes Paket als
// eigenen Prozess und lief ohne diesen Lock in einen echten Race
// (`CREATE TABLE IF NOT EXISTS` ist in Postgres NICHT race-frei gegen
// gleichzeitige Erstversuche, siehe docs/decisions.md D1). Dieselbe
// Technik ist bereits als Baustein für Orchestrator-HA vorgesehen
// (ARCHITECTURE.md §19.3: Leader-Wahl über eine Postgres-Advisory-Lock)
// — hier schon einmal in echtem Einsatz, nicht neu erfunden.
const migrationLockKey = 84271936

// Connect öffnet den Postgres-Pool. `database/sql` verbindet lazy (der
// erste echte Query-Fehler zeigt Erreichbarkeitsprobleme), deshalb
// zusätzlich ein `Ping()`, damit ein nicht erreichbarer Postgres beim
// Start sofort auffällt statt erst beim ersten API-Aufruf.
func Connect(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return db, nil
}

// Migrate wendet alle noch nicht angewendeten Dateien aus migrations/
// an (lexikalische Reihenfolge, deshalb das `NNNN_`-Präfix in den
// Dateinamen) — verfolgt per `schema_migrations`-Tabelle, welche Version
// bereits lief. Läuft komplett auf einer einzigen, per
// `pg_advisory_lock` gesperrten Verbindung (s. `migrationLockKey`) —
// advisory locks sind session-/verbindungsgebunden, ein Pool-Zugriff über
// `*sql.DB` direkt würde die Sperre nicht zuverlässig durchsetzen. Jede
// Datei läuft zusätzlich in einer eigenen Transaktion; schlägt eine fehl,
// bleiben bereits angewendete frühere Migrationen bestehen (kein
// Rollback über Dateigrenzen hinweg nötig, da jede Datei für sich atomar
// ist).
func Migrate(db *sql.DB) error {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("db: acquire connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return fmt.Errorf("db: acquire migration lock: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockKey)
	}()

	if _, err := conn.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     TEXT PRIMARY KEY,
			applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`); err != nil {
		return fmt.Errorf("db: create schema_migrations: %w", err)
	}

	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("db: read embedded migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var applied bool
		if err := conn.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)`, name,
		).Scan(&applied); err != nil {
			return fmt.Errorf("db: check migration %s: %w", name, err)
		}
		if applied {
			continue
		}

		sqlBytes, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("db: read migration %s: %w", name, err)
		}

		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("db: begin migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("db: apply migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("db: record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("db: commit migration %s: %w", name, err)
		}
	}
	return nil
}

// Package dbtest liefert eine isolierte Postgres-Testdatenbank für
// Store-Tests, die eine echte Datenbank brauchen.
//
// Root-caused nach einem echten Datenverlust-Vorfall (2026-08-07,
// docs/decisions.md): vier Pakete (workflows, snapshots, launcher ×2)
// hielten je eine eigene, wortgleich kopierte `testDB()`-Hilfsfunktion,
// die beim Testlauf bedingungslos `DELETE FROM <tabelle>` gegen die
// Datenbank hinter OMP_POSTGRES_URL ausführte. Nachtrag 108 (früherer
// Vorfall, s. dortige Doku in den einzelnen `*_test.go`-Dateien) hatte
// nur den STILLEN Fallback auf die Standard-Dev-DSN entfernt — der
// Fall, dass OMP_POSTGRES_URL ABSICHTLICH auf die echte, per `make
// start` laufende Dev-Postgres zeigt (genau das, was `make test`/`make
// check` laut Makefile-Kommentar bewusst tun sollen, "damit die DB-Tests
// weiterhin real gegen die Dev-Postgres laufen"), blieb genauso
// destruktiv wie zuvor. Ein `go test ./...`-Lauf mit exakt dieser,
// beabsichtigten DSN löschte dabei die echten Workflows "Regieplatz 1"
// und "PC-MXL-Test" unwiederbringlich (kein Backup jünger als deren
// Erstellungsdatum vorhanden).
//
// Open verbindet stattdessen zu einer von der Ziel-DSN ABGELEITETEN,
// separaten "<db>_test"-Datenbank (automatisch angelegt, falls sie noch
// nicht existiert) — Tests dürfen darin beliebig aggressiv aufräumen
// (volle Tabellen leeren), OHNE JE die App-Datenbank zu berühren, ganz
// gleich, welche DSN übergeben wird.
package dbtest

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/lib/pq"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// postgresDuplicateDatabase ist der Postgres-Fehlercode für
// "database already exists" (Klasse 42 — Syntax Error or Access Rule
// Violation, konkret duplicate_database) — erwarteter, harmloser
// Ausgang von CREATE DATABASE bei jedem Testlauf außer dem allerersten.
const postgresDuplicateDatabase = "42P04"

// Open liefert eine migrierte Verbindung zur isolierten Testdatenbank,
// abgeleitet von OMP_POSTGRES_URL (Datenbankname + "_test"). Bricht den
// Test per t.Skip ab, wenn OMP_POSTGRES_URL nicht gesetzt ist oder
// Postgres nicht erreichbar ist — kein impliziter Fallback (Nachtrag
// 108 bleibt in Kraft, gilt jetzt zusätzlich zur DB-Isolation oben).
func Open(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("OMP_POSTGRES_URL")
	if dsn == "" {
		t.Skip("OMP_POSTGRES_URL nicht gesetzt — DB-Test übersprungen (kein impliziter Fallback, s. docs/decisions.md Nachtrag 108)")
	}

	testDSN, testDBName, err := deriveTestDSN(dsn)
	if err != nil {
		t.Fatalf("dbtest: DSN nicht verwertbar: %v", err)
	}
	if err := ensureDatabaseExists(dsn, testDBName); err != nil {
		t.Skipf("dbtest: isolierte Testdatenbank %q nicht anlegbar (%v)", testDBName, err)
	}

	database, err := db.Connect(testDSN)
	if err != nil {
		t.Skipf("postgres (Testdatenbank) nicht erreichbar (%v)", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return database
}

// deriveTestDSN hängt "_test" an den Datenbanknamen aus dsn an — alles
// andere (Host/Port/Nutzer/Passwort/Query-Parameter) bleibt unverändert,
// damit lokale wie CI-DSNs ohne weitere Konfiguration funktionieren.
func deriveTestDSN(dsn string) (testDSN, dbName string, err error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", "", fmt.Errorf("parse: %w", err)
	}
	original := strings.TrimPrefix(u.Path, "/")
	if original == "" {
		return "", "", fmt.Errorf("DSN ohne Datenbankname: %s", dsn)
	}
	dbName = original + "_test"
	derived := *u
	derived.Path = "/" + dbName
	return derived.String(), dbName, nil
}

// ensureDatabaseExists verbindet zur URSPRÜNGLICHEN Ziel-DSN (nicht zu
// Postgres' "postgres"-Wartungsdatenbank — für den lokalen Dev-Container
// reicht das, derselbe Nutzer legt beim ersten `make up` auch schon die
// App-Datenbank selbst an, hat also CREATEDB) nur für das eine CREATE
// DATABASE. Ein bereits existierendes "<db>_test" (jeder Testlauf außer
// dem allerersten) ist der Normalfall, kein Fehler.
func ensureDatabaseExists(originalDSN, testDBName string) error {
	admin, err := sql.Open("postgres", originalDSN)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer admin.Close()

	_, err = admin.Exec(fmt.Sprintf("CREATE DATABASE %s", pq.QuoteIdentifier(testDBName)))
	if err == nil {
		return nil
	}
	if pqErr, ok := err.(*pq.Error); ok && string(pqErr.Code) == postgresDuplicateDatabase {
		return nil
	}
	return err
}

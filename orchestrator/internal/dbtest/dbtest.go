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
//
// Seit Nachtrag 270 zusätzlich JE TESTPAKET eine eigene Datenbank
// ("<db>_test_<paket>", Paketname aus dem Testbinary abgeleitet): `go
// test ./...` führt Pakete parallel aus, und eine gemeinsame
// "<db>_test" ließ Pakete gegenseitig in dieselben Tabellen greifen — der
// Outbox-Relay-Test versendete dabei Events des Asset-Pakets (teils in
// den ECHTEN OMP_EVENTS-Stream des Dev-Clusters), Asset-Tests löschten
// per DELETE FROM outbox_events die Events des Outbox-Pakets. Mehrere
// sporadische Fehlschläge im Voll-Lauf gingen darauf zurück.
package dbtest

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
)

// postgresDuplicateDatabase ist der Postgres-Fehlercode für
// "database already exists" (Klasse 42 — Syntax Error or Access Rule
// Violation, konkret duplicate_database) — erwarteter, harmloser
// Ausgang von CREATE DATABASE bei jedem Testlauf außer dem allerersten.
const postgresDuplicateDatabase = "42P04"

// postgresObjectInUse (55006): CREATE DATABASE kopiert template1 und
// scheitert, solange eine andere Sitzung — etwa das parallel startende
// Testbinary eines anderen Pakets beim eigenen CREATE DATABASE — gerade
// darauf zugreift. Vorübergehend, daher kurz wiederholen.
const postgresObjectInUse = "55006"

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

	testDSN, testDBName, err := deriveTestDSN(dsn, testPackageName(os.Args[0]))
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

// testPackageName leitet aus dem Pfad des Testbinaries ("…/outbox.test")
// einen als Datenbanknamen-Suffix tauglichen Paketnamen ab ("outbox") —
// nur [a-z0-9_], leer, wenn nichts Verwertbares übrig bleibt.
func testPackageName(binary string) string {
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(binary)), ".test")
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		case r == '-' || r == '.':
			b.WriteRune('_')
		}
	}
	name := b.String()
	if len(name) > 40 { // Postgres-Bezeichner max. 63 Zeichen inkl. "<db>_test_"
		name = name[:40]
	}
	return name
}

// deriveTestDSN hängt "_test" (und, falls gesetzt, "_<pkg>") an den
// Datenbanknamen aus dsn an — alles andere (Host/Port/Nutzer/Passwort/
// Query-Parameter) bleibt unverändert, damit lokale wie CI-DSNs ohne
// weitere Konfiguration funktionieren.
func deriveTestDSN(dsn, pkg string) (testDSN, dbName string, err error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", "", fmt.Errorf("parse: %w", err)
	}
	original := strings.TrimPrefix(u.Path, "/")
	if original == "" {
		return "", "", fmt.Errorf("DSN ohne Datenbankname: %s", dsn)
	}
	dbName = original + "_test"
	if pkg != "" {
		dbName += "_" + pkg
	}
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
	admin, err := sql.Open("pgx", originalDSN)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer admin.Close()

	for attempt := 0; ; attempt++ {
		_, err = admin.Exec(fmt.Sprintf("CREATE DATABASE %s", pgx.Identifier{testDBName}.Sanitize()))
		if err == nil {
			return nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == postgresDuplicateDatabase {
			return nil
		}
		if errors.As(err, &pgErr) && pgErr.Code == postgresObjectInUse && attempt < 50 {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		return err
	}
}

package dbtest

import (
	"strings"
	"testing"
)

func TestDeriveTestDSNAppendsSuffixToDatabaseNameOnly(t *testing.T) {
	testDSN, dbName, err := deriveTestDSN("postgres://omp:omp@localhost:5432/omp?sslmode=disable", "")
	if err != nil {
		t.Fatalf("deriveTestDSN() error = %v", err)
	}
	if dbName != "omp_test" {
		t.Fatalf("dbName = %q, want %q", dbName, "omp_test")
	}
	want := "postgres://omp:omp@localhost:5432/omp_test?sslmode=disable"
	if testDSN != want {
		t.Fatalf("testDSN = %q, want %q", testDSN, want)
	}
}

func TestDeriveTestDSNRejectsDSNWithoutDatabaseName(t *testing.T) {
	if _, _, err := deriveTestDSN("postgres://omp:omp@localhost:5432/", ""); err == nil {
		t.Fatal("deriveTestDSN() error = nil, want an error for a DSN without a database name")
	}
}

// TestOpenNeverTouchesTheOriginalDatabase ist der eigentliche
// Regressionstest für den Vorfall: Open() muss IMMER auf "<db>_test"
// landen, egal was OMP_POSTGRES_URL sagt — hier live gegen echtes
// Postgres geprüft (Skip ohne OMP_POSTGRES_URL, wie jeder andere
// DB-Test dieses Projekts).
func TestOpenNeverTouchesTheOriginalDatabase(t *testing.T) {
	database := Open(t)

	var currentDB string
	if err := database.QueryRow(`SELECT current_database()`).Scan(&currentDB); err != nil {
		t.Fatalf("SELECT current_database() error = %v", err)
	}
	if currentDB == "omp" {
		t.Fatalf("Open() connected to the real dev database %q — this is exactly the incident this package prevents", currentDB)
	}
	// Seit Nachtrag 270 "<db>_test_<paket>" (hier: omp_test_dbtest).
	if !strings.Contains(currentDB, "_test") {
		t.Fatalf("current_database() = %q, want an isolated <db>_test… database", currentDB)
	}
}

func TestDeriveTestDSNPerPackageDatabase(t *testing.T) {
	_, dbName, err := deriveTestDSN("postgres://omp:omp@localhost:5432/omp?sslmode=disable", testPackageName("/tmp/go-build123/b001/outbox.test"))
	if err != nil || dbName != "omp_test_outbox" {
		t.Fatalf("dbName = %q, %v; want omp_test_outbox", dbName, err)
	}
	if got := testPackageName("/x/My-Pkg.v2.test"); got != "my_pkg_v2" {
		t.Fatalf("testPackageName = %q, want my_pkg_v2", got)
	}
}

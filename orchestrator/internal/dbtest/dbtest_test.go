package dbtest

import "testing"

func TestDeriveTestDSNAppendsSuffixToDatabaseNameOnly(t *testing.T) {
	testDSN, dbName, err := deriveTestDSN("postgres://omp:omp@localhost:5432/omp?sslmode=disable")
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
	if _, _, err := deriveTestDSN("postgres://omp:omp@localhost:5432/"); err == nil {
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
	if !hasTestSuffix(currentDB) {
		t.Fatalf("current_database() = %q, want a name ending in _test", currentDB)
	}
}

func hasTestSuffix(name string) bool {
	const suffix = "_test"
	return len(name) > len(suffix) && name[len(name)-len(suffix):] == suffix
}

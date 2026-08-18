package backup

import (
	"os"
	"path/filepath"
	"testing"
)

// Create() selbst braucht einen echten `podman`/Postgres-Container und
// wird deshalb nicht hier, sondern live gegen die echte Dev-Umgebung
// verifiziert (gleiches Prinzip wie andere podman-anfassende Pfade im
// Projekt) — List/rotate/Path sind reine Dateisystem-Logik, hier per
// echtem temporären Verzeichnis geprüft.

func touch(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
		t.Fatalf("touch %s: %v", name, err)
	}
}

func TestListReturnsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "omp-20260101T000000Z.sql.gz")
	touch(t, dir, "omp-20260301T000000Z.sql.gz")
	touch(t, dir, "omp-20260201T000000Z.sql.gz")
	touch(t, dir, "not-a-backup.txt")

	svc := NewService(nil, dir, 14)
	names, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := []string{"omp-20260301T000000Z.sql.gz", "omp-20260201T000000Z.sql.gz", "omp-20260101T000000Z.sql.gz"}
	if len(names) != len(want) {
		t.Fatalf("List() = %v, want %v", names, want)
	}
	for i, n := range want {
		if names[i] != n {
			t.Errorf("List()[%d] = %q, want %q", i, names[i], n)
		}
	}
}

func TestListOnMissingDirReturnsEmptyNotError(t *testing.T) {
	svc := NewService(nil, filepath.Join(t.TempDir(), "does-not-exist"), 14)
	names, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("List() = %v, want empty", names)
	}
}

func TestRotateKeepsOnlyNewestN(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "omp-20260101T000000Z.sql.gz")
	touch(t, dir, "omp-20260102T000000Z.sql.gz")
	touch(t, dir, "omp-20260103T000000Z.sql.gz")

	svc := NewService(nil, dir, 2)
	if err := svc.rotate(); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	names, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("after rotate, List() = %v, want 2 entries", names)
	}
	if names[0] != "omp-20260103T000000Z.sql.gz" || names[1] != "omp-20260102T000000Z.sql.gz" {
		t.Errorf("rotate kept the wrong files: %v", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "omp-20260101T000000Z.sql.gz")); !os.IsNotExist(err) {
		t.Errorf("oldest backup should have been removed by rotate, stat err = %v", err)
	}
}

func TestPathRejectsPathTraversal(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "omp-20260101T000000Z.sql.gz")
	svc := NewService(nil, dir, 14)

	if _, err := svc.Path("../../../etc/passwd"); err == nil {
		t.Fatal("Path() should reject a traversal attempt")
	}
	if _, err := svc.Path("omp-20260101T000000Z.sql.gz"); err != nil {
		t.Fatalf("Path() should accept a real, existing backup name: %v", err)
	}
	if _, err := svc.Path("omp-does-not-exist.sql.gz"); err == nil {
		t.Fatal("Path() should reject a name that isn't an existing file")
	}
}

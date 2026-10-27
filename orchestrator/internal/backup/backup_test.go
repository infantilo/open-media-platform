package backup

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

func gzipBytes(t *testing.T, data string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write([]byte(data)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// Import() — Nutzerfund 2026-08-27 ("backup kann downgeloaded werden,
// aber nicht per upload im Browser wiederhergestellt werden").
func TestImportWritesUploadedBackupUnderNewServerSideName(t *testing.T) {
	dir := t.TempDir()
	svc := NewService(nil, dir, 14)

	result, err := svc.Import(gzipBytes(t, "-- sql dump content --"))
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if result.Name == "" {
		t.Fatal("Import() returned an empty Name")
	}
	names, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 1 || names[0] != result.Name {
		t.Fatalf("List() = %v, want exactly [%q]", names, result.Name)
	}
	path, err := svc.Path(result.Name)
	if err != nil {
		t.Fatalf("Path(%q): %v", result.Name, err)
	}
	gr, err := gzip.NewReader(mustOpen(t, path))
	if err != nil {
		t.Fatalf("imported file is not valid gzip: %v", err)
	}
	defer gr.Close()
	got, err := readAll(gr)
	if err != nil {
		t.Fatalf("read decompressed content: %v", err)
	}
	if string(got) != "-- sql dump content --" {
		t.Errorf("decompressed content = %q, want the original uploaded payload", got)
	}
}

func TestImportRejectsNonGzipData(t *testing.T) {
	svc := NewService(nil, t.TempDir(), 14)
	if _, err := svc.Import([]byte("not gzip at all")); err == nil {
		t.Fatal("Import() should reject data that isn't valid gzip")
	}
}

func TestImportRejectsEmptyUpload(t *testing.T) {
	svc := NewService(nil, t.TempDir(), 14)
	if _, err := svc.Import(nil); err == nil {
		t.Fatal("Import() should reject an empty upload")
	}
}

// Import() geht durch dieselbe Rotation wie Create() — eine
// hochgeladene Sicherung zählt wie jede andere gegen das Limit.
func TestImportAppliesRotation(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "omp-20260101T000000Z.sql.gz")
	touch(t, dir, "omp-20260102T000000Z.sql.gz")
	svc := NewService(nil, dir, 2)

	if _, err := svc.Import(gzipBytes(t, "x")); err != nil {
		t.Fatalf("Import: %v", err)
	}
	names, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("after Import with keep=2, List() = %v, want 2 entries", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "omp-20260101T000000Z.sql.gz")); !os.IsNotExist(err) {
		t.Errorf("oldest backup should have been rotated away after Import, stat err = %v", err)
	}
}

func mustOpen(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func readAll(r *gzip.Reader) ([]byte, error) {
	var buf bytes.Buffer
	_, err := buf.ReadFrom(r)
	return buf.Bytes(), err
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

func TestKeyBundleRoundTripAndWrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "a.key"), []byte("geheim-a"), 0o600))
	must(os.MkdirAll(filepath.Join(dir, "ca", "sub"), 0o700))
	must(os.WriteFile(filepath.Join(dir, "ca", "sub", "ca.key"), []byte("geheim-ca"), 0o600))
	data, n, err := BundleKeys([]string{filepath.Join(dir, "a.key"), filepath.Join(dir, "ca"), filepath.Join(dir, "fehlt")}, "pass")
	must(err)
	if n != 2 {
		t.Fatalf("n=%d", n)
	}
	if bytes.Contains(data, []byte("geheim")) {
		t.Fatal("Klartext im Bündel")
	}
	got, err := OpenKeys(data, "pass")
	must(err)
	found := 0
	for name, b := range got {
		if strings.HasSuffix(name, "a.key") && string(b) == "geheim-a" || strings.HasSuffix(name, "ca/sub/ca.key") && string(b) == "geheim-ca" {
			found++
		}
	}
	if found != 2 {
		t.Fatalf("%v", got)
	}
	if _, err := OpenKeys(data, "falsch"); err == nil {
		t.Fatal("falsche Passphrase muss scheitern")
	}
	if _, err := OpenKeys([]byte("irgendwas langes genug um die Laenge zu erfuellen....."), "pass"); err == nil {
		t.Fatal("kein Bündel")
	}
	if _, _, err := BundleKeys([]string{filepath.Join(dir, "a.key")}, ""); err == nil {
		t.Fatal("ohne Passphrase kein Bündel")
	}
	if d, n, err := BundleKeys([]string{filepath.Join(dir, "fehlt")}, "pass"); err != nil || n != 0 || d != nil {
		t.Fatalf("nichts zu sichern: %v %d", err, n)
	}
}

func TestExtrasWriteBundleCopyAndRotateTogether(t *testing.T) {
	dir, far := t.TempDir(), t.TempDir()
	key := filepath.Join(t.TempDir(), "k")
	_ = os.WriteFile(key, []byte("x"), 0o600)
	s := NewService(nil, dir, 1).WithExtras([]string{key}, "pw", far)
	var warns []string
	s.Warn = func(m string, err error) { warns = append(warns, m+": "+err.Error()) }
	for _, name := range []string{"omp-20260101T000000Z.sql.gz", "omp-20260102T000000Z.sql.gz"} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, []byte("dump"), 0o600)
		s.extras(name, p)
		_ = s.rotate()
	}
	if len(warns) != 0 {
		t.Fatal(warns)
	}
	for _, d := range []string{dir, far} {
		ents, _ := os.ReadDir(d)
		var names []string
		for _, e := range ents {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		if strings.Join(names, ",") != "omp-20260102T000000Z.keys.enc,omp-20260102T000000Z.sql.gz" {
			t.Fatalf("%s: %v", d, names)
		}
	}
}

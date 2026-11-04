package jobwire

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func run[T any](t *testing.T, op FileOp) T {
	t.Helper()
	b, err := RunFileOp(op)
	if err != nil {
		t.Fatalf("%s: %v", op.Op, err)
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func newRoot(t *testing.T) string {
	r := filepath.Join(t.TempDir(), "media", "root")
	if err := os.MkdirAll(filepath.Join(r, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"a.mxf", "sub/b.srt", "c.mxf"} {
		if err := os.WriteFile(filepath.Join(r, f), []byte("12345"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func TestStatListTrashRestore(t *testing.T) {
	root := newRoot(t)
	st := run[[]FileStat](t, FileOp{Op: FileOpStat, Root: root, Rels: []string{"a.mxf", "gone.mxf", "../x", "/etc/passwd", "sub/b.srt"}})
	if !st[0].Exists || st[0].Size != 5 || st[1].Exists || st[1].Err != "" || st[2].Err == "" || st[3].Err == "" || !st[4].Exists {
		t.Fatalf("stat: %+v", st)
	}
	l := run[FileListResult](t, FileOp{Op: FileOpList, Root: root, Limit: 2})
	if len(l.Entries) != 2 || l.Next == "" || l.Entries[0].Name != "a.mxf" {
		t.Fatalf("list: %+v", l)
	}
	l2 := run[FileListResult](t, FileOp{Op: FileOpList, Root: root, Limit: 2, Cursor: l.Next})
	if len(l2.Entries) != 1 || l2.Next != "" || l2.Entries[0].Name != "sub" || !l2.Entries[0].IsDir {
		t.Fatalf("list2: %+v", l2)
	}
	tr := run[[]TrashResult](t, FileOp{Op: FileOpTrash, Root: root, Rels: []string{"a.mxf", "sub/b.srt", "nope"}})
	if !tr[0].OK || !tr[1].OK || tr[2].OK {
		t.Fatalf("trash: %+v", tr)
	}
	if _, err := os.Stat(filepath.Join(root, "a.mxf")); err == nil {
		t.Fatal("Datei noch da")
	}
	tl := run[[]TrashEntry](t, FileOp{Op: FileOpTrashList, Root: root})
	if len(tl) != 2 {
		t.Fatalf("trash-list: %+v", tl)
	}
	// Papierkorb ist in der Wurzelliste unsichtbar und kein Ziel.
	for _, e := range run[FileListResult](t, FileOp{Op: FileOpList, Root: root}).Entries {
		if e.Name == TrashDirName {
			t.Fatal(".trash sichtbar")
		}
	}
	if _, err := RunFileOp(FileOp{Op: FileOpList, Root: root, Rel: ".trash"}); err == nil {
		t.Fatal("Papierkorb listbar")
	}
	rs := run[[]TrashResult](t, FileOp{Op: FileOpRestore, Root: root, IDs: []string{tl[0].ID}})
	if !rs[0].OK {
		t.Fatalf("restore: %+v", rs)
	}
	// Wiederherstellen überschreibt nie.
	if err := os.WriteFile(filepath.Join(root, tl[1].Rel), []byte("neu"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := run[[]TrashResult](t, FileOp{Op: FileOpRestore, Root: root, IDs: []string{tl[1].ID}}); r[0].OK {
		t.Fatalf("restore überschrieb: %+v", r)
	}
}

func TestSymlinkEscapeAndBadRoot(t *testing.T) {
	root := newRoot(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	st := run[[]FileStat](t, FileOp{Op: FileOpStat, Root: root, Rels: []string{"link/secret"}})
	if st[0].Exists || st[0].Err == "" {
		t.Fatalf("Symlink-Ausbruch: %+v", st[0])
	}
	tr := run[[]TrashResult](t, FileOp{Op: FileOpTrash, Root: root, Rels: []string{"link/secret"}})
	if tr[0].OK {
		t.Fatal("Datei außerhalb verschoben")
	}
	if _, err := os.Stat(filepath.Join(outside, "secret")); err != nil {
		t.Fatal("Datei außerhalb verändert")
	}
	if _, err := RunFileOp(FileOp{Op: FileOpList, Root: root, Rel: "link"}); err == nil {
		t.Fatal("Listing außerhalb")
	}
	for _, bad := range []string{"", "relativ", "/"} {
		if _, err := RunFileOp(FileOp{Op: FileOpTrash, Root: bad, Rels: []string{"x"}}); err == nil {
			t.Fatalf("Wurzel %q akzeptiert", bad)
		}
	}
	if _, err := RunFileOp(FileOp{Op: "boom", Root: root}); err == nil {
		t.Fatal("unbekannte Operation")
	}
}

func TestPurge(t *testing.T) {
	root := newRoot(t)
	run[[]TrashResult](t, FileOp{Op: FileOpTrash, Root: root, Rels: []string{"a.mxf"}})
	time.Sleep(5 * time.Millisecond)
	cut := unixMs(time.Now())
	time.Sleep(5 * time.Millisecond)
	run[[]TrashResult](t, FileOp{Op: FileOpTrash, Root: root, Rels: []string{"c.mxf"}})
	p := run[PurgeResult](t, FileOp{Op: FileOpPurge, Root: root, OlderThanMs: cut})
	if p.Removed != 1 || p.FreedBytes != 5 {
		t.Fatalf("purge older: %+v", p)
	}
	if tl := run[[]TrashEntry](t, FileOp{Op: FileOpTrashList, Root: root}); len(tl) != 1 || tl[0].Rel != "c.mxf" {
		t.Fatalf("Rest: %+v", tl)
	}
	// Notfall: Schutzfrist hält das junge Stück zurück, ohne Schutzfrist wird geleert (unerreichbares Ziel → alles).
	p = run[PurgeResult](t, FileOp{Op: FileOpPurge, Root: root, FreeBytes: 1 << 62, KeepNewerThanMs: cut - 1})
	if p.Removed != 0 {
		t.Fatalf("Schutzfrist missachtet: %+v", p)
	}
	p = run[PurgeResult](t, FileOp{Op: FileOpPurge, Root: root, FreeBytes: 1 << 62})
	if p.Removed != 1 {
		t.Fatalf("Notfall: %+v", p)
	}
	if _, err := RunFileOp(FileOp{Op: FileOpPurge, Root: root}); err == nil {
		t.Fatal("purge ohne Kriterium")
	}
	if d := run[DFResult](t, FileOp{Op: FileOpDF, Root: root}); d.Total <= 0 {
		t.Fatalf("df: %+v", d)
	}
}

func TestHungMountDoesNotBlockAndRecovers(t *testing.T) {
	root := newRoot(t)
	release := make(chan struct{})
	orig := runner
	defer func() { runner = orig }()
	var calls atomic.Int32
	runner = func(op FileOp) ([]byte, error) {
		if calls.Add(1) == 1 {
			<-release // simuliert hängenden Mount
		}
		return orig(op)
	}
	t0 := time.Now()
	_, err := RunFileOpTimeout(FileOp{Op: FileOpStat, Root: root, Rels: []string{"a.mxf"}}, 150*time.Millisecond)
	if !IsMountHung(err) || time.Since(t0) > time.Second {
		t.Fatalf("Frist: %v nach %v", err, time.Since(t0))
	}
	// Solange die Goroutine hängt: sofortige Abweisung, keine zweite Goroutine.
	t1 := time.Now()
	_, err = RunFileOpTimeout(FileOp{Op: FileOpList, Root: root}, time.Second)
	if !IsMountHung(err) || time.Since(t1) > 100*time.Millisecond || calls.Load() != 1 {
		t.Fatalf("Schnellabweisung: %v nach %v, calls=%d", err, time.Since(t1), calls.Load())
	}
	// Eine andere Wurzel ist nicht betroffen.
	other := newRoot(t)
	if _, err := RunFileOpTimeout(FileOp{Op: FileOpDF, Root: other}, time.Second); err != nil {
		t.Fatalf("andere Wurzel: %v", err)
	}
	// Mount antwortet wieder → die Wurzel arbeitet ohne Neustart weiter.
	close(release)
	time.Sleep(50 * time.Millisecond)
	if _, err := RunFileOpTimeout(FileOp{Op: FileOpStat, Root: root, Rels: []string{"a.mxf"}}, time.Second); err != nil {
		t.Fatalf("nach Erholung: %v", err)
	}
	if !IsMountHung(errors.New("host x: " + MountHungText + ": y")) {
		t.Fatal("Text-Erkennung über NATS")
	}
}

func TestConcurrentOpsOnSameRootAreNotHung(t *testing.T) {
	root := newRoot(t)
	orig := runner
	defer func() { runner = orig }()
	gate := make(chan struct{})
	runner = func(op FileOp) ([]byte, error) { <-gate; return orig(op) }
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, err := RunFileOpTimeout(FileOp{Op: FileOpDF, Root: root}, 2*time.Second); errs <- err }()
	}
	time.Sleep(100 * time.Millisecond) // beide laufen gleichzeitig, keine ist über der Frist
	close(gate)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("gleichzeitige Operation abgewiesen: %v", err)
		}
	}
}

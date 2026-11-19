package jobwire

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func xfer(t *testing.T, op FileOp, out any) error {
	t.Helper()
	raw, err := RunFileOp(op)
	if err != nil {
		return err
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatal(err)
		}
	}
	return nil
}

func xferRoot(t *testing.T) string {
	t.Helper()
	d := filepath.Join(t.TempDir(), "media")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	return d
}

// Eine Datei blockweise lesen und in eine zweite Wurzel schreiben: Inhalt, Größe und Zeit stimmen, bis zum commit nur die halbe Datei.
func TestChunkedCopyRoundTrip(t *testing.T) {
	src, dst := xferRoot(t), xferRoot(t)
	payload := bytes.Repeat([]byte("0123456789abcdef"), MaxChunk/16*2+37) // gut zwei Blöcke und ein Rest
	if err := os.MkdirAll(filepath.Join(src, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a", "clip.mxf"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	var off int64
	for {
		var c ChunkResult
		if err := xfer(t, FileOp{Op: FileOpReadChunk, Root: src, Rel: "a/clip.mxf", Offset: off, Limit: MaxChunk}, &c); err != nil {
			t.Fatal(err)
		}
		if c.SHA != SHAOf(c.Data) {
			t.Fatal("Prüfsumme des Blocks stimmt nicht")
		}
		var w WriteResult
		if err := xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "neu/ordner/clip.mxf", Offset: off, Data: c.Data}, &w); err != nil {
			t.Fatal(err)
		}
		if w.SHA != c.SHA {
			t.Fatal("der Zielort hat andere Bytes empfangen")
		}
		off += int64(len(c.Data))
		if c.EOF {
			break
		}
	}
	if _, err := os.Stat(filepath.Join(dst, "neu/ordner/clip.mxf")); err == nil {
		t.Fatal("vor dem commit darf die Zieldatei nicht unter ihrem Namen stehen")
	}
	if _, err := os.Stat(filepath.Join(dst, "neu/ordner/clip.mxf"+TempSuffix)); err != nil {
		t.Fatalf("halbe Datei fehlt: %v", err)
	}
	var cr CommitResult
	if err := xfer(t, FileOp{Op: FileOpCommit, Root: dst, Rel: "neu/ordner/clip.mxf", Size: int64(len(payload)), MTimeMs: 1_700_000_000_000}, &cr); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dst, "neu/ordner/clip.mxf"))
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("Zieldatei weicht ab (%v)", err)
	}
	st, _ := os.Stat(filepath.Join(dst, "neu/ordner/clip.mxf"))
	if st.ModTime().UnixMilli() != 1_700_000_000_000 {
		t.Fatalf("Änderungszeit nicht übernommen: %v", st.ModTime())
	}
	if _, err := os.Stat(filepath.Join(dst, "neu/ordner/clip.mxf"+TempSuffix)); err == nil {
		t.Fatal("halbe Datei muss nach commit weg sein")
	}
}

func TestWriteChunkRejectsGapsAndOversize(t *testing.T) {
	dst := xferRoot(t)
	if err := xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "x.bin", Offset: 0, Data: []byte("abc")}, nil); err != nil {
		t.Fatal(err)
	}
	if err := xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "x.bin", Offset: 10, Data: []byte("zzz")}, nil); err == nil {
		t.Fatal("ein Block mit Lücke muss abgelehnt werden")
	}
	if err := xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "x.bin", Offset: 3, Data: make([]byte, MaxChunk+1)}, nil); err == nil {
		t.Fatal("zu großer Block muss abgelehnt werden")
	}
}

func TestCommitChecksSizeAndConflict(t *testing.T) {
	dst := xferRoot(t)
	_ = xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "x.bin", Offset: 0, Data: []byte("abc")}, nil)
	if err := xfer(t, FileOp{Op: FileOpCommit, Root: dst, Rel: "x.bin", Size: 99}, nil); err == nil {
		t.Fatal("falsche Größe muss abgelehnt werden")
	}
	if err := xfer(t, FileOp{Op: FileOpCommit, Root: dst, Rel: "x.bin", Size: 3}, nil); err != nil {
		t.Fatal(err)
	}
	// zweite Übertragung auf denselben Namen
	_ = xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "x.bin", Offset: 0, Data: []byte("neu")}, nil)
	if err := xfer(t, FileOp{Op: FileOpCommit, Root: dst, Rel: "x.bin", Size: 3}, nil); err == nil {
		t.Fatal("ohne Überschreiben darf eine vorhandene Datei nicht ersetzt werden")
	}
	if err := xfer(t, FileOp{Op: FileOpCommit, Root: dst, Rel: "x.bin", Size: 3, Overwrite: true}, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "x.bin"))
	if string(got) != "neu" {
		t.Fatalf("Inhalt = %q", got)
	}
	// die alte Fassung liegt im Papierkorb, nicht verloren
	var tl []TrashEntry
	if err := xfer(t, FileOp{Op: FileOpTrashList, Root: dst}, &tl); err != nil || len(tl) != 1 {
		t.Fatalf("Papierkorb = %+v (%v), want die alte Datei", tl, err)
	}
}

func TestAbortRemovesPartialFile(t *testing.T) {
	dst := xferRoot(t)
	_ = xfer(t, FileOp{Op: FileOpWriteChunk, Root: dst, Rel: "y.bin", Offset: 0, Data: []byte("abc")}, nil)
	if err := xfer(t, FileOp{Op: FileOpAbort, Root: dst, Rel: "y.bin"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "y.bin"+TempSuffix)); err == nil {
		t.Fatal("halbe Datei muss weg sein")
	}
	if err := xfer(t, FileOp{Op: FileOpAbort, Root: dst, Rel: "y.bin"}, nil); err != nil {
		t.Fatalf("zweites Abbrechen darf nicht scheitern: %v", err)
	}
}

func TestMoveWithinRoot(t *testing.T) {
	r := xferRoot(t)
	_ = os.WriteFile(filepath.Join(r, "a.mxf"), []byte("1"), 0o644)
	_ = os.WriteFile(filepath.Join(r, "b.mxf"), []byte("2"), 0o644)
	if err := xfer(t, FileOp{Op: FileOpMove, Root: r, Rel: "a.mxf", DstRel: "ordner/a.mxf"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r, "ordner/a.mxf")); err != nil {
		t.Fatal("Ziel fehlt")
	}
	if err := xfer(t, FileOp{Op: FileOpMove, Root: r, Rel: "b.mxf", DstRel: "ordner/a.mxf"}, nil); err == nil {
		t.Fatal("Ziel existiert: ohne Überschreiben ablehnen")
	}
	if err := xfer(t, FileOp{Op: FileOpMove, Root: r, Rel: "b.mxf", DstRel: "ordner/a.mxf", Overwrite: true}, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(r, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := xfer(t, FileOp{Op: FileOpMove, Root: r, Rel: "d", DstRel: "d/innen"}, nil); err == nil {
		t.Fatal("Ordner in sich selbst verschieben muss abgelehnt werden")
	}
}

func TestTransferOpsStayInsideTheRoot(t *testing.T) {
	r := xferRoot(t)
	for _, op := range []FileOp{
		{Op: FileOpReadChunk, Root: r, Rel: "../etc/passwd"},
		{Op: FileOpWriteChunk, Root: r, Rel: "../x", Data: []byte("a")},
		{Op: FileOpWriteChunk, Root: r, Rel: "/abs", Data: []byte("a")},
		{Op: FileOpMove, Root: r, Rel: "a", DstRel: "../b"},
		{Op: FileOpMkdir, Root: r, Rel: "../d"},
		{Op: FileOpWriteChunk, Root: r, Rel: ".trash/x", Data: []byte("a")},
	} {
		if err := xfer(t, op, nil); err == nil {
			t.Errorf("Operation %+v wurde nicht abgelehnt", op)
		}
	}
}

func TestUniqueRel(t *testing.T) {
	taken := map[string]bool{"a/clip.mxf": true, "a/clip (2).mxf": true}
	if got := UniqueRel("a/clip.mxf", func(s string) bool { return taken[s] }); got != "a/clip (3).mxf" {
		t.Fatalf("UniqueRel = %q", got)
	}
	if got := UniqueRel("frei.mxf", func(s string) bool { return taken[s] }); got != "frei.mxf" {
		t.Fatalf("UniqueRel(frei) = %q", got)
	}
}

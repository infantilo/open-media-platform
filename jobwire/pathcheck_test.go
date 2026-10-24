package jobwire

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHasParentSegment(t *testing.T) {
	yes := []string{"..", "../x", "a/../b", "../../etc/passwd", `..\x`, "movie=../secret.mp4", "subtitles='../a.srt'", "x:../y", "/abs/../x", "a/.."}
	no := []string{"", "file..mp4", "a.b", "...", "1..5", "x=1..5", "-vf", "scale=1280:720", "/media/a..b/c.mp4", ".hidden", "./x", "a/.b/c"}
	for _, a := range yes {
		if !HasParentSegment(a) {
			t.Errorf("%q muss erkannt werden", a)
		}
	}
	for _, a := range no {
		if HasParentSegment(a) {
			t.Errorf("%q darf nicht erkannt werden", a)
		}
	}
}

func TestEmbeddedAbsPaths(t *testing.T) {
	got := EmbeddedAbsPaths("movie=/etc/passwd,scale=1:1")
	if len(got) != 1 || got[0] != "/etc/passwd" {
		t.Fatalf("%v", got)
	}
	if len(EmbeddedAbsPaths("scale=1280:720")) != 0 {
		t.Fatal("kein Pfad")
	}
}

func TestUnderRootsResolvesSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skip(err)
	}
	if !UnderRoots(filepath.Join(root, "neu", "out.mp4"), []string{root}) {
		t.Error("nicht vorhandene Ausgabe unter der Wurzel")
	}
	if UnderRoots(filepath.Join(root, "link", "x.mp4"), []string{root}) {
		t.Error("Symlink aus der Wurzel hinaus muss abgelehnt werden")
	}
	if UnderRoots(filepath.Join(root, "..", "x"), []string{root}) {
		t.Error("..-Ausbruch")
	}
	if UnderRoots("/etc/passwd", nil) {
		t.Error("ohne Wurzeln nichts erlaubt")
	}
}

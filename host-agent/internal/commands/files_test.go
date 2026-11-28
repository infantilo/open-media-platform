package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/infantilo/openmediaplatform/jobwire"
)

func TestHandleFilesAllowlist(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "media", "a")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "x.mxf"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := &Executor{}
	req := Request{Action: jobwire.ActionFiles, FileOp: &jobwire.FileOp{Op: jobwire.FileOpStat, Root: root, Rels: []string{"x.mxf"}}}
	t.Setenv("OMP_FILE_ROOTS", "")
	t.Setenv("OMP_MEDIA_MOUNTS", "")
	if r := e.Handle(req); r.OK {
		t.Fatal("ohne Freigabe akzeptiert")
	}
	t.Setenv("OMP_MEDIA_MOUNTS", filepath.Join(base, "media"))
	r := e.Handle(req)
	if !r.OK {
		t.Fatalf("Freigabe über OMP_MEDIA_MOUNTS: %+v", r)
	}
	var st []jobwire.FileStat
	if err := json.Unmarshal([]byte(r.Detail), &st); err != nil || len(st) != 1 || !st[0].Exists {
		t.Fatalf("stat: %v %+v", err, st)
	}
	t.Setenv("OMP_FILE_ROOTS", filepath.Join(base, "andere"))
	if r := e.Handle(req); r.OK {
		t.Fatal("Wurzel außerhalb der Allowlist akzeptiert")
	}
	t.Setenv("OMP_FILE_ROOTS", filepath.Join(base, "media"))
	if r := e.Handle(req); !r.OK {
		t.Fatalf("mit Allowlist: %+v", r)
	}
	if r := e.Handle(Request{Action: jobwire.ActionFiles}); r.OK {
		t.Fatal("ohne fileOp akzeptiert")
	}
}

// Symlink aus der Freigabe heraus, relative Wurzel und Verzeichnisse des Agents werden abgewiesen.
func TestHandleFilesBoundaries(t *testing.T) {
	base := t.TempDir()
	media, outside := filepath.Join(base, "media"), filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(media, "agent"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(media, "raus")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMP_FILE_ROOTS", media)
	e := &Executor{}
	e.SetProtectedPaths(filepath.Join(media, "agent", "state.json"), "")
	stat := func(root string) Response {
		return e.Handle(Request{Action: jobwire.ActionFiles, FileOp: &jobwire.FileOp{Op: jobwire.FileOpStat, Root: root, Rels: []string{"x"}}})
	}
	for name, root := range map[string]string{
		"Symlink nach außen": filepath.Join(media, "raus"), "Dateisystemwurzel": "/", "relativ": "media",
		"enthält den Zustand": media, "Verzeichnis des Zustands": filepath.Join(media, "agent"),
	} {
		if r := stat(root); r.OK {
			t.Errorf("%s (%s) akzeptiert", name, root)
		}
	}
	sub := filepath.Join(media, "clips")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if r := stat(sub); !r.OK {
		t.Errorf("freigegebenes Unterverzeichnis abgelehnt: %+v", r)
	}
}

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
	r := e.Handle(req)
	if !r.OK {
		t.Fatalf("ohne Allowlist: %+v", r)
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

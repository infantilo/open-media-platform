package commands

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOrphanPIDsMatchesExactInstanceID(t *testing.T) {
	root := t.TempDir()
	write := func(pid, env string) {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "environ"), []byte(env), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("101", "PATH=/bin\x00OMP_INSTANCE_ID=abc\x00OMP_LABEL=x\x00")
	write("102", "OMP_INSTANCE_ID=abcd\x00") // anderes, längeres ID: kein Treffer
	write("103", "FOO=OMP_INSTANCE_ID=abc\x00")
	write("104", "OMP_INSTANCE_ID=abc")
	if err := os.MkdirAll(filepath.Join(root, "self"), 0o755); err != nil { // kein PID-Verzeichnis
		t.Fatal(err)
	}

	got := orphanPIDs(root, "abc")
	if len(got) != 2 || !((got[0] == 101 && got[1] == 104) || (got[0] == 104 && got[1] == 101)) {
		t.Fatalf("orphanPIDs = %v, want [101 104]", got)
	}
	if got := orphanPIDs(root, ""); got != nil {
		t.Fatalf("empty instance id must match nothing, got %v", got)
	}
}

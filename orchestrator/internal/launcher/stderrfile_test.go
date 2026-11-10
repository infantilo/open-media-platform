package launcher

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Nutzerfund 2026-11-10: Nodes mit stderr-Pipe starben nach einem Orchestrator-Neustart beim ersten Log-Schreiben.
// Mit Log-Datei als stderr bleibt der Node unabhängig vom Orchestrator-Prozess; die Crash-Zeilen kommen aus der Datei.
func TestRegularFileStderrSurvivesParentAndFeedsTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orchestrator.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got, ok := regularFileOf(f); !ok || got != path {
		t.Fatalf("regularFileOf = %q, %v", got, ok)
	}
	r, w, _ := os.Pipe()
	defer r.Close()
	defer w.Close()
	if _, ok := regularFileOf(w); ok {
		t.Fatal("a pipe must not count as regular file")
	}
	_, _ = f.WriteString("alt\n")
	tail := newTailBuffer(2)
	tail.fromFile(path)
	cmd := exec.Command("sh", "-c", "echo eins >&2; echo zwei >&2; echo drei >&2")
	cmd.Stderr = f // direkt die Datei, kein Pipe-Zwischenglied
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	got := tail.String()
	if got != "zwei\ndrei" || strings.Contains(got, "alt") {
		t.Fatalf("tail = %q, want last two lines after start offset", got)
	}
}

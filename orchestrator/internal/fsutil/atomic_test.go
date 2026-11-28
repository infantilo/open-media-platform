package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileAtomicReplacesContentModeAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("alt und länger"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("neu"), 0o600); err != nil {
		t.Fatalf("write error = %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "neu" {
		t.Errorf("content = %q, want %q", got, "neu")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v (err %v), want 0600", info.Mode().Perm(), err)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Errorf("%d entries in dir, want only the target file", len(ents))
	}
}

// Schlägt das Ersetzen fehl (Ziel ist ein Verzeichnis), bleibt keine temporäre Datei zurück.
func TestWriteFileAtomicCleansUpOnFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "occupied")
	if err := os.MkdirAll(filepath.Join(path, "child"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("x"), 0o600); err == nil {
		t.Fatal("expected an error")
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Errorf("%d entries in dir, want no leftover temp file", len(ents))
	}
}

func TestWriteFileAtomicKeepsSymlink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "real"), filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("alt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(link, []byte("neu"), 0o600); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(link); info.Mode()&os.ModeSymlink == 0 {
		t.Error("symlink was replaced by a regular file")
	}
	if got, _ := os.ReadFile(target); string(got) != "neu" {
		t.Errorf("target = %q", got)
	}
}

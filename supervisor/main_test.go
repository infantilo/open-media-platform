package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBackupPathRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	if _, err := os.Create(filepath.Join(dir, "omp-real.sql.gz")); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		file    string
		wantErr bool
	}{
		{"real file", "omp-real.sql.gz", false},
		{"traversal", "../../../etc/passwd", true},
		{"empty", "", true},
		{"dot", ".", true},
		{"dotdot", "..", true},
		{"missing file", "omp-does-not-exist.sql.gz", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := resolveBackupPath(dir, c.file)
			if (err != nil) != c.wantErr {
				t.Errorf("resolveBackupPath(%q) error = %v, wantErr %v", c.file, err, c.wantErr)
			}
		})
	}
}

func TestStatusBeginRejectsConcurrentRestore(t *testing.T) {
	s := &status{}
	if !s.begin("omp-a.sql.gz") {
		t.Fatal("first begin() should succeed")
	}
	if s.begin("omp-b.sql.gz") {
		t.Fatal("second concurrent begin() should be rejected while busy")
	}
	s.finish(nil)
	if !s.begin("omp-c.sql.gz") {
		t.Fatal("begin() after finish() should succeed again")
	}
}

func TestStatusFinishRecordsOutcome(t *testing.T) {
	s := &status{}
	s.begin("omp-a.sql.gz")
	s.setPhase("restoring")
	if got := s.snapshot().Phase; got != "restoring" {
		t.Errorf("Phase = %q, want %q", got, "restoring")
	}
	s.finish(nil)
	snap := s.snapshot()
	if snap.Busy {
		t.Error("Busy should be false after finish")
	}
	if snap.Ok == nil || !*snap.Ok {
		t.Error("Ok should be true after finish(nil)")
	}
	if snap.Error != "" {
		t.Errorf("Error should be empty on success, got %q", snap.Error)
	}
}

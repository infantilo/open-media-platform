package mxldomains

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestValidateName(t *testing.T) {
	for _, ok := range []string{"a", "test", "studio-2", "live1", "a-b-c"} {
		if err := ValidateName(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "default", "Test", "1a", "-a", "a-", "a--b", "a b", "a/b", "../x", "a.b", "ä", "x234567890123456789012345678901234"} {
		if err := ValidateName(bad); !errors.Is(err, ErrValidation) {
			t.Errorf("%q muss abgelehnt werden, war: %v", bad, err)
		}
	}
}

func TestPathDerivation(t *testing.T) {
	s := NewStore(nil, "/dev/shm/omp-mxl/")
	if s.PathFor("") != "/dev/shm/omp-mxl" || s.PathFor("default") != "/dev/shm/omp-mxl" {
		t.Fatal("Standarddomain")
	}
	if s.PathFor("test") != "/dev/shm/omp-mxl-test" {
		t.Fatalf("PathFor = %q", s.PathFor("test"))
	}
	for path, want := range map[string]string{
		"/dev/shm/omp-mxl":      "default",
		"":                      "default",
		"/dev/shm/omp-mxl-test": "test",
		"/dev/shm/omp-mxl-Bad":  "/dev/shm/omp-mxl-Bad",
		"/dev/shm/anders":       "/dev/shm/anders",
		"/dev/shm/omp-mxl-a--b": "/dev/shm/omp-mxl-a--b",
	} {
		if got := s.NameForPath(path); got != want {
			t.Errorf("NameForPath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestStoreLifecycle(t *testing.T) {
	db := dbtest.Open(t)
	base := filepath.Join(t.TempDir(), "omp-mxl")
	s := NewStore(db, base)

	l, err := s.List()
	if err != nil || len(l) != 1 || !l[0].Default || l[0].Path != base {
		t.Fatalf("leere Liste = %+v, %v", l, err)
	}
	if _, err := s.Resolve("test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannt: %v", err)
	}
	d, err := s.Create("test", "Testlauf", "alice", false)
	if err != nil || d.Path != base+"-test" {
		t.Fatalf("Create = %+v, %v", d, err)
	}
	if st, err := os.Stat(d.Path); err != nil || !st.IsDir() {
		t.Fatalf("Verzeichnis fehlt: %v", err)
	}
	if _, err := s.Create("test", "", "alice", false); !errors.Is(err, ErrExists) {
		t.Fatalf("doppelt: %v", err)
	}
	if _, err := s.Create("default", "", "alice", false); !errors.Is(err, ErrValidation) {
		t.Fatalf("default: %v", err)
	}
	if p, err := s.Resolve("test"); err != nil || p != base+"-test" {
		t.Fatalf("Resolve = %q, %v", p, err)
	}
	if p, err := s.Resolve("default"); err != nil || p != base {
		t.Fatalf("Resolve default = %q, %v", p, err)
	}
	l, _ = s.List()
	if len(l) != 2 || l[1].Name != "test" || l[1].Description != "Testlauf" {
		t.Fatalf("Liste = %+v", l)
	}

	// Abschottung gilt ab dem Anlegen
	if _, err := s.Create("sicher", "", "alice", true); err != nil {
		t.Fatal(err)
	}
	if !s.Isolated("sicher") || s.Isolated("test") || s.Isolated("default") || s.Isolated("") || s.Isolated("nope") {
		t.Fatal("Isolated falsch")
	}
	if l, _ := s.List(); len(l) != 3 || !l[1].Isolated {
		t.Fatalf("Liste = %+v", l)
	}

	// Delete entfernt nur ein LEERES Verzeichnis
	if err := os.MkdirAll(filepath.Join(d.Path, "x.mxl-flow"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("test"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.Path); err != nil {
		t.Fatalf("nicht leeres Verzeichnis darf nicht entfernt werden: %v", err)
	}
	if err := s.Delete("test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("zweites Löschen: %v", err)
	}
	if err := s.Delete("default"); !errors.Is(err, ErrValidation) {
		t.Fatalf("default löschen: %v", err)
	}
}

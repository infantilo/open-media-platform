package launcher

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCatalog(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return path
}

func TestLoadCatalogDefaultsRunnerToProcess(t *testing.T) {
	path := writeCatalog(t, `[{"type":"omp-source","label":"Source","command":["true"],"env":{}}]`)

	entries, err := LoadCatalog(path)
	if err != nil {
		t.Fatalf("LoadCatalog() error = %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Runner != "process" {
		t.Errorf("Runner = %q, want %q", entries[0].Runner, "process")
	}
}

func TestLoadCatalogPreservesExplicitRunner(t *testing.T) {
	path := writeCatalog(t, `[{"type":"x","label":"X","runner":"podman","command":["true"]}]`)

	entries, err := LoadCatalog(path)
	if err != nil {
		t.Fatalf("LoadCatalog() error = %v", err)
	}
	if entries[0].Runner != "podman" {
		t.Errorf("Runner = %q, want %q", entries[0].Runner, "podman")
	}
}

func TestLoadCatalogRejectsMissingType(t *testing.T) {
	path := writeCatalog(t, `[{"label":"X","command":["true"]}]`)

	if _, err := LoadCatalog(path); err == nil {
		t.Fatal("LoadCatalog() error = nil, want error for missing type")
	}
}

func TestLoadCatalogRejectsEmptyCommand(t *testing.T) {
	path := writeCatalog(t, `[{"type":"x","label":"X","command":[]}]`)

	if _, err := LoadCatalog(path); err == nil {
		t.Fatal("LoadCatalog() error = nil, want error for empty command")
	}
}

func TestLoadCatalogResolvesRelativePathCommandsAgainstCatalogDir(t *testing.T) {
	path := writeCatalog(t, `[{"type":"omp-source","label":"Source","command":["../nodes/target/debug/omp-source","--flag"],"env":{}}]`)

	entries, err := LoadCatalog(path)
	if err != nil {
		t.Fatalf("LoadCatalog() error = %v", err)
	}
	want := filepath.Join(filepath.Dir(path), "../nodes/target/debug/omp-source")
	if entries[0].Command[0] != want {
		t.Errorf("Command[0] = %q, want %q", entries[0].Command[0], want)
	}
	if entries[0].Command[1] != "--flag" {
		t.Errorf("Command[1] = %q, want unchanged %q", entries[0].Command[1], "--flag")
	}
}

func TestLoadCatalogLeavesBareCommandsUnchanged(t *testing.T) {
	path := writeCatalog(t, `[{"type":"x","label":"X","command":["true"]}]`)

	entries, err := LoadCatalog(path)
	if err != nil {
		t.Fatalf("LoadCatalog() error = %v", err)
	}
	if entries[0].Command[0] != "true" {
		t.Errorf("Command[0] = %q, want unchanged %q", entries[0].Command[0], "true")
	}
}

func TestLoadCatalogLeavesAbsolutePathCommandsUnchanged(t *testing.T) {
	path := writeCatalog(t, `[{"type":"x","label":"X","command":["/usr/bin/true"]}]`)

	entries, err := LoadCatalog(path)
	if err != nil {
		t.Fatalf("LoadCatalog() error = %v", err)
	}
	if entries[0].Command[0] != "/usr/bin/true" {
		t.Errorf("Command[0] = %q, want unchanged %q", entries[0].Command[0], "/usr/bin/true")
	}
}

func TestLoadCatalogMissingFileReturnsError(t *testing.T) {
	if _, err := LoadCatalog(filepath.Join(t.TempDir(), "does-not-exist.json")); err == nil {
		t.Fatal("LoadCatalog() error = nil, want error for missing file")
	}
}

func TestLoadCatalogInvalidJSONReturnsError(t *testing.T) {
	path := writeCatalog(t, `not json`)
	if _, err := LoadCatalog(path); err == nil {
		t.Fatal("LoadCatalog() error = nil, want error for invalid JSON")
	}
}

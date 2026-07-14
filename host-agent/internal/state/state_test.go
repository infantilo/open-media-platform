package state

import (
	"path/filepath"
	"testing"
)

func TestLoadMissingFileReturnsNotOK(t *testing.T) {
	_, ok, err := Load(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if ok {
		t.Errorf("Load() ok = true, want false for missing file")
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	want := State{HostID: "host-1", Label: "Test Host"}

	if err := Save(path, want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, ok, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !ok || got != want {
		t.Fatalf("Load() = %+v, ok=%v, want %+v, ok=true", got, ok, want)
	}
}

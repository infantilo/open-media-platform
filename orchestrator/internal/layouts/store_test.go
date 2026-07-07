package layouts

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestGetUnknownNameReturnsNotFound(t *testing.T) {
	s := NewStore(t.TempDir())
	_, err := s.Get("default")
	if err != ErrNotFound {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestPutThenGetRoundTrips(t *testing.T) {
	s := NewStore(t.TempDir())
	body := json.RawMessage(`{"positions":{"node-1":{"x":1,"y":2}}}`)

	if err := s.Put("default", body); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	got, err := s.Get("default")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got) != string(body) {
		t.Errorf("Get() = %s, want %s", got, body)
	}
}

func TestPutOverwritesExisting(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Put("default", json.RawMessage(`{"v":1}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := s.Put("default", json.RawMessage(`{"v":2}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	got, _ := s.Get("default")
	if string(got) != `{"v":2}` {
		t.Errorf("Get() = %s, want {\"v\":2}", got)
	}
}

func TestPutRejectsInvalidJSON(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Put("default", json.RawMessage(`not json`)); err == nil {
		t.Fatal("Put(invalid JSON) error = nil, want error")
	}
}

func TestPathTraversalNameRejected(t *testing.T) {
	s := NewStore(t.TempDir())
	for _, name := range []string{"../escape", "a/b", "a\\b", "", "with space"} {
		if err := s.Put(name, json.RawMessage(`{}`)); err != ErrInvalidName {
			t.Errorf("Put(%q) error = %v, want ErrInvalidName", name, err)
		}
		if _, err := s.Get(name); err != ErrInvalidName {
			t.Errorf("Get(%q) error = %v, want ErrInvalidName", name, err)
		}
	}
}

func TestStoreCreatesDirectoryIfMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "layouts")
	s := NewStore(dir)
	if err := s.Put("default", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
}

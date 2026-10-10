package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadIOPortsEmptyPathReturnsNil(t *testing.T) {
	ports, err := loadIOPorts("")
	if err != nil {
		t.Fatalf("loadIOPorts(\"\") error = %v", err)
	}
	if ports != nil {
		t.Errorf("loadIOPorts(\"\") = %v, want nil", ports)
	}
}

func TestLoadIOPortsParsesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "io-ports.json")
	content := `[
		{"portId":"decklink-0-in","cardType":"decklink","direction":"in","label":"DeckLink 1 In"},
		{"portId":"decklink-0-out","cardType":"decklink","direction":"out"}
	]`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	ports, err := loadIOPorts(path)
	if err != nil {
		t.Fatalf("loadIOPorts() error = %v", err)
	}
	if len(ports) != 2 {
		t.Fatalf("loadIOPorts() = %+v, want 2 entries", ports)
	}
	if ports[0].PortID != "decklink-0-in" || ports[0].Direction != "in" || ports[0].Label != "DeckLink 1 In" {
		t.Errorf("ports[0] = %+v, unexpected", ports[0])
	}
	if ports[1].PortID != "decklink-0-out" || ports[1].Direction != "out" || ports[1].Label != "" {
		t.Errorf("ports[1] = %+v, unexpected", ports[1])
	}
}

func TestLoadIOPortsMissingFileErrors(t *testing.T) {
	if _, err := loadIOPorts("/no/such/file.json"); err == nil {
		t.Fatal("loadIOPorts() error = nil, want error for missing file")
	}
}

func TestLoadIOPortsInvalidJSONErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	if _, err := loadIOPorts(path); err == nil {
		t.Fatal("loadIOPorts() error = nil, want error for invalid JSON")
	}
}

func TestAdvertiseHost(t *testing.T) {
	t.Setenv("OMP_HOST_AGENT_ADVERTISE_HOST", "")
	if got := advertiseHost("http://localhost:8000"); got != "" {
		t.Errorf("localhost orchestrator: got %q, want empty (keep loopback default)", got)
	}
	if got := advertiseHost("http://127.0.0.1:8000"); got != "" {
		t.Errorf("loopback orchestrator: got %q, want empty", got)
	}
	t.Setenv("OMP_HOST_AGENT_ADVERTISE_HOST", "10.1.2.3")
	if got := advertiseHost("http://localhost:8000"); got != "10.1.2.3" {
		t.Errorf("override: got %q, want 10.1.2.3", got)
	}
}

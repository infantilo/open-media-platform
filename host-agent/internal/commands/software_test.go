package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

func TestSoftwareReportsStampsRunningAndMissingMarker(t *testing.T) {
	dir := t.TempDir()
	stamped := filepath.Join(dir, "omp-stamped")
	os.WriteFile(stamped, []byte("xx OMPBUILD1{\"version\":\"2026.11.1\",\"commit\":\"abc123\",\"builtAt\":\"2026-11-01T00:00:00Z\"}OMPBUILD1END yy"), 0o755)
	plain := filepath.Join(dir, "omp-plain")
	os.WriteFile(plain, []byte("kein Stempel"), 0o755)
	e := NewExecutor([]catalog.Entry{
		{Type: "stamped", Runner: catalog.RunnerProcess, Command: []string{stamped}},
		{Type: "plain", Runner: catalog.RunnerProcess, Command: []string{plain}},
		{Type: "sleeper", Runner: catalog.RunnerProcess, Command: []string{"sleep", "30"}},
	}, "", "", "", "h", nil)
	if r := e.Handle(Request{Action: "start", Type: "sleeper", InstanceID: "s1"}); !r.OK {
		t.Fatal(r.Error)
	}
	defer e.Handle(Request{Action: "stop", InstanceID: "s1"})
	resp := e.Handle(Request{Action: "software"})
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	var rep SoftwareReport
	if err := json.Unmarshal([]byte(resp.Detail), &rep); err != nil {
		t.Fatal(err)
	}
	by := map[string]SoftwareNode{}
	for _, n := range rep.Nodes {
		by[n.Type] = n
	}
	if n := by["stamped"]; n.Version != "2026.11.1" || n.Commit != "abc123" || n.Source != "binary" || n.Binary != "omp-stamped" {
		t.Fatalf("stamped: %+v", n)
	}
	if n := by["plain"]; n.Version != "" || n.Error == "" {
		t.Fatalf("plain: %+v", n)
	}
	if n := by["sleeper"]; n.Running != 1 {
		t.Fatalf("sleeper: %+v", n)
	}
	if rep.Agent.Version == "" {
		t.Fatal("Agent-Version fehlt")
	}
	// Binary ersetzt → neuer Stempel trotz Zwischenspeicher
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(stamped, []byte("OMPBUILD1{\"version\":\"2026.11.2\"}OMPBUILD1END and more bytes"), 0o755)
	resp = e.Handle(Request{Action: "software"})
	json.Unmarshal([]byte(resp.Detail), &rep)
	for _, n := range rep.Nodes {
		if n.Type == "stamped" && n.Version != "2026.11.2" {
			t.Fatalf("Zwischenspeicher nicht erneuert: %+v", n)
		}
	}
}

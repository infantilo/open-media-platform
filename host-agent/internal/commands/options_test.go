package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/nodeoptions"
)

func optExecutor(t *testing.T, envFile string) *Executor {
	t.Helper()
	// Der „Node“ schreibt seine Umgebung in eine Datei, damit der Test sie prüfen kann.
	e := NewExecutor([]catalog.Entry{
		{Type: "tester", Runner: catalog.RunnerProcess, Command: []string{"sh", "-c", "env > " + envFile + "; sleep 5"}},
	}, "", "", "", "host-1", nil)
	e.SetNodeOptions(map[string][]nodeoptions.Option{"tester": {
		{Key: "OMP_MEDIA_DIR", Label: "Medien", Type: nodeoptions.TypePath, PathKind: nodeoptions.PathDir, MustExist: true},
		{Key: "OMP_WIDTH", Label: "Breite", Type: nodeoptions.TypeInt, Min: ptr(16)},
	}})
	return e
}

func ptr(v float64) *float64 { return &v }

func waitFile(t *testing.T, p string) string {
	t.Helper()
	for i := 0; i < 50; i++ {
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			return string(b)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Prozess hat keine Umgebung geschrieben")
	return ""
}

func TestStartAppliesDeclaredOptionsValidatedOnThisHost(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, "env.txt")
	e := optExecutor(t, envFile)

	resp := e.Handle(Request{Action: "start", Type: "tester", InstanceID: "o1",
		Options: map[string]string{"OMP_MEDIA_DIR": dir, "OMP_WIDTH": "1280", "OMP_FREI_ERFUNDEN": "x"}})
	if !resp.OK {
		t.Fatalf("Start: %+v", resp)
	}
	defer e.Handle(Request{Action: "stop", InstanceID: "o1"})
	env := waitFile(t, envFile)
	if !strings.Contains(env, "OMP_MEDIA_DIR="+dir) || !strings.Contains(env, "OMP_WIDTH=1280") {
		t.Fatalf("Optionen fehlen in der Umgebung:\n%s", env)
	}
	if strings.Contains(env, "OMP_FREI_ERFUNDEN") {
		t.Fatal("nicht deklarierte Variable darf nie gesetzt werden (Sicherheitsgrenze)")
	}
	if !strings.Contains(resp.Detail, "OMP_FREI_ERFUNDEN") {
		t.Fatalf("Ignoriertes muss gemeldet werden: %q", resp.Detail)
	}
}

func TestStartRejectsInvalidDeclaredOptionAndPathMissingOnThisHost(t *testing.T) {
	e := optExecutor(t, filepath.Join(t.TempDir(), "env.txt"))
	for name, opts := range map[string]map[string]string{
		"Pfad fehlt auf diesem Host": {"OMP_MEDIA_DIR": "/gibt/es/hier/nicht"},
		"Zahl zu klein":              {"OMP_WIDTH": "4"},
		"keine Zahl":                 {"OMP_WIDTH": "breit"},
	} {
		if resp := e.Handle(Request{Action: "start", Type: "tester", InstanceID: "bad", Options: opts}); resp.OK {
			e.Handle(Request{Action: "stop", InstanceID: "bad"})
			t.Errorf("%s: Start hätte scheitern müssen", name)
		}
	}
}

func TestOptionsForTypeWithoutSchemaAreIgnoredNotApplied(t *testing.T) {
	envFile := filepath.Join(t.TempDir(), "env.txt")
	e := NewExecutor([]catalog.Entry{
		{Type: "tester", Runner: catalog.RunnerProcess, Command: []string{"sh", "-c", "env > " + envFile + "; sleep 5"}},
	}, "", "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "start", Type: "tester", InstanceID: "o2", Options: map[string]string{"OMP_WIDTH": "1280"}})
	if !resp.OK || !strings.Contains(resp.Detail, "OMP_WIDTH") {
		t.Fatalf("%+v", resp)
	}
	defer e.Handle(Request{Action: "stop", InstanceID: "o2"})
	if strings.Contains(waitFile(t, envFile), "OMP_WIDTH=1280") {
		t.Fatal("ohne agent-lokales Schema darf nichts gesetzt werden")
	}
}

func TestCheckPathAction(t *testing.T) {
	dir := t.TempDir()
	e := NewExecutor(nil, "", "", "", "host-1", nil)
	resp := e.Handle(Request{Action: "check-path", Path: dir, Kind: "dir"})
	var info nodeoptions.PathInfo
	if err := json.Unmarshal([]byte(resp.Detail), &info); err != nil || !resp.OK || !info.Readable {
		t.Fatalf("%+v %v %+v", resp, err, info)
	}
	if resp := e.Handle(Request{Action: "check-path"}); resp.OK {
		t.Fatal("ohne Pfad: Fehler")
	}
}

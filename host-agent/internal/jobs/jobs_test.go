package jobs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fakePub struct {
	mu  sync.Mutex
	evs []Event
}

func (f *fakePub) Publish(_ string, data []byte) error {
	var e Event
	_ = json.Unmarshal(data, &e)
	f.mu.Lock()
	f.evs = append(f.evs, e)
	f.mu.Unlock()
	return nil
}

func (f *fakePub) done(id string) (Event, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.evs {
		if e.JobID == id && e.Type == "done" {
			return e, true
		}
	}
	return Event{}, false
}

func wait(t *testing.T, f *fakePub, id string) Event {
	t.Helper()
	for i := 0; i < 200; i++ {
		if e, ok := f.done(id); ok {
			return e
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("kein done-Ereignis")
	return Event{}
}

func newRunner(t *testing.T, tools map[string]ToolConfig, allowNet bool) (*Runner, *fakePub, string) {
	root := t.TempDir()
	pub := &fakePub{}
	cfg := Config{Tools: tools, JobRoots: []string{root}, AllowNet: allowNet, MaxJobs: 2}
	return NewRunner(cfg, "h1", t.TempDir(), pub), pub, root
}

func TestValidatePfadeUndProtokolle(t *testing.T) {
	r, _, root := newRunner(t, map[string]ToolConfig{"ffmpeg": {Path: "/usr/bin/ffmpeg"}}, false)
	ok := []string{"-i", filepath.Join(root, "a.mxf"), "-c:v", "libx264", "-vf", "scale=1280:720", filepath.Join(root, "out.mp4")}
	args, err := r.Validate("ffmpeg", ok)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(args, " ")[:len("-nostdin -hide_banner")] != "-nostdin -hide_banner" {
		t.Fatalf("Grundoptionen fehlen: %v", args)
	}
	wl := 0
	for i, a := range args {
		if a == "-protocol_whitelist" && args[i+1] == "file,pipe" {
			wl++
		}
	}
	if wl != 1 {
		t.Fatalf("Whitelist vor -i erwartet: %v", args)
	}
	for _, bad := range [][]string{
		{"-i", "/etc/passwd", filepath.Join(root, "o.mp4")},
		{"-i", "rtmp://x/y", filepath.Join(root, "o.mp4")},
		{"-i", "concat:a|b", filepath.Join(root, "o.mp4")},
		{"-vf", "movie=/etc/passwd[x]", "-i", filepath.Join(root, "a")},
		{"-i", filepath.Join(root, "..", "..", "etc", "passwd")},
	} {
		if _, err := r.Validate("ffmpeg", bad); err == nil {
			t.Errorf("abgelehnt erwartet: %v", bad)
		}
	}
	if _, err := r.Validate("rm", []string{"-rf"}); err == nil {
		t.Error("nicht freigegebenes Programm muss abgelehnt werden")
	}
	ra, _, root2 := newRunner(t, map[string]ToolConfig{"ffmpeg": {Path: "/usr/bin/ffmpeg"}}, true)
	if _, err := ra.Validate("ffmpeg", []string{"-i", "srt://h:1", filepath.Join(root2, "o.ts")}); err != nil {
		t.Errorf("mit allowNet erlaubt: %v", err)
	}
}

func TestSymlinkAusbruch(t *testing.T) {
	r, _, root := newRunner(t, map[string]ToolConfig{"ffprobe": {Path: "/usr/bin/ffprobe"}}, false)
	link := filepath.Join(root, "link")
	if err := os.Symlink("/etc", link); err != nil {
		t.Skip(err)
	}
	if _, err := r.Validate("ffprobe", []string{filepath.Join(link, "passwd")}); err == nil {
		t.Fatal("Symlink aus der Wurzel heraus muss abgelehnt werden")
	}
}

func fakeTool(t *testing.T, script string) string {
	p := filepath.Join(t.TempDir(), "tool.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExecErgebnisUndStdout(t *testing.T) {
	r, pub, _ := newRunner(t, map[string]ToolConfig{"sh": {Path: fakeTool(t, `echo '{"ok":true}'; echo zeile >&2; exit 3`)}}, false)
	if _, err := r.Exec(Request{JobID: "j1", Tool: "sh"}); err != nil {
		t.Fatal(err)
	}
	d := wait(t, pub, "j1")
	if d.ExitCode != 3 || d.Error != "" || d.Chunks != 1 {
		t.Fatalf("%+v", d)
	}
	if len(d.Tail) == 0 || d.Tail[len(d.Tail)-1] != "zeile" {
		t.Fatalf("tail: %v", d.Tail)
	}
	pub.mu.Lock()
	defer pub.mu.Unlock()
	var out []byte
	for _, e := range pub.evs {
		if e.Type == "stdout" {
			out = append(out, e.Data...)
		}
	}
	if strings.TrimSpace(string(out)) != `{"ok":true}` {
		t.Fatalf("stdout: %q", out)
	}
}

func TestCancelPauseUndGrenzen(t *testing.T) {
	r, pub, _ := newRunner(t, map[string]ToolConfig{"sh": {Path: fakeTool(t, `sleep 30`)}}, false)
	if _, err := r.Exec(Request{JobID: "a", Tool: "sh"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Exec(Request{JobID: "a", Tool: "sh"}); err == nil {
		t.Error("doppelte jobId")
	}
	if _, err := r.Exec(Request{JobID: "b", Tool: "sh"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Exec(Request{JobID: "c", Tool: "sh"}); err == nil {
		t.Error("Gesamtgrenze muss greifen")
	}
	if err := r.Pause("a", true); err != nil {
		t.Fatal(err)
	}
	if l := r.List(); len(l) != 2 || !l[0].Paused {
		t.Fatalf("%v", l)
	}
	if err := r.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	_ = r.Cancel("b")
	d := wait(t, pub, "a")
	if d.Error != "abgebrochen" {
		t.Fatalf("%+v", d)
	}
	wait(t, pub, "b")
	if len(r.List()) != 0 {
		t.Error("Liste muss leer sein")
	}
}

func TestTimeout(t *testing.T) {
	r, pub, _ := newRunner(t, map[string]ToolConfig{"sh": {Path: fakeTool(t, `sleep 30`)}}, false)
	if _, err := r.Exec(Request{JobID: "t", Tool: "sh", TimeoutS: 1}); err != nil {
		t.Fatal(err)
	}
	if d := wait(t, pub, "t"); d.Error != "Zeitlimit überschritten" {
		t.Fatalf("%+v", d)
	}
}

func TestLoadFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "tools.json")
	_ = os.WriteFile(p, []byte(`{"tools":{"ffmpeg":{"path":"ffmpeg"}},"jobRoots":["/srv"]}`), 0o644)
	if _, err := LoadFile(p); err == nil {
		t.Error("relativer Pfad muss abgelehnt werden")
	}
	_ = os.WriteFile(p, []byte(`{"tools":{"ffmpeg":{"path":"/usr/bin/ffmpeg"}},"jobRoots":["/srv/"]}`), 0o644)
	c, err := LoadFile(p)
	if err != nil || c.JobRoots[0] != "/srv" || c.MaxJobs != 2 {
		t.Fatalf("%v %+v", err, c)
	}
	_ = exec.Command
}

func TestAblehnungIstDauerhaft(t *testing.T) {
	r, _, root := newRunner(t, map[string]ToolConfig{"ffmpeg": {Path: "/usr/bin/ffmpeg"}}, false)
	_, err := r.Validate("ffmpeg", []string{"-i", "/etc/passwd", root + "/o.mp4"})
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("Verstoß gegen die Freigabe ist eine RejectError: %v", err)
	}
	if _, err := r.Exec(Request{JobID: "x", Tool: "ffmpeg", Args: []string{"-i", "/etc/passwd"}}); !errors.As(err, &rej) {
		t.Fatalf("%v", err)
	}
}

func TestShutdownBeendetJobsUndMeldetAbbruch(t *testing.T) {
	r, pub, _ := newRunner(t, map[string]ToolConfig{"sh": {Path: fakeTool(t, `sleep 30`)}}, false)
	if _, err := r.Exec(Request{JobID: "s1", Tool: "sh"}); err != nil {
		t.Fatal(err)
	}
	r.Shutdown(5 * time.Second)
	d := wait(t, pub, "s1")
	if d.Error != "abgebrochen" || len(r.List()) != 0 {
		t.Fatalf("%+v", d)
	}
}

func TestCleanupStaleBeendetVerwaisteProzesse(t *testing.T) {
	tool := fakeTool(t, `sleep 30`)
	workDir := t.TempDir()
	cfg := Config{Tools: map[string]ToolConfig{"sh": {Path: tool}}, JobRoots: []string{t.TempDir()}, MaxJobs: 2}
	r1 := NewRunner(cfg, "h", workDir, &fakePub{})
	pid, err := r1.Exec(Request{JobID: "orphan", Tool: "sh"})
	if err != nil {
		t.Fatal(err)
	}
	// Absturz simulieren: der neue Runner kennt den Job nicht, nur die PID-Datei im Arbeitsverzeichnis
	r2 := NewRunner(cfg, "h", workDir, &fakePub{})
	// fremde PID-Datei (Prozess läuft, ist aber kein Job-Programm) darf nicht getroffen werden
	other := filepath.Join(workDir, "fremd")
	_ = os.MkdirAll(other, 0o750)
	_ = os.WriteFile(filepath.Join(other, "pid"), []byte(fmt.Sprint(os.Getpid())), 0o640)
	if n := r2.CleanupStale(); n != 1 {
		t.Fatalf("beendet: %d", n)
	}
	for i := 0; i < 100; i++ {
		if syscall.Kill(pid, 0) != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	wait(t, r1.pub.(*fakePub), "orphan") // der alte Runner meldet das Ende des Prozesses
	if _, err := os.Stat(filepath.Join(workDir, "orphan")); err == nil {
		t.Fatal("Arbeitsverzeichnis muss aufgeräumt sein")
	}
	if syscall.Kill(os.Getpid(), 0) != nil {
		t.Fatal("eigener Prozess lebt natürlich")
	}
}

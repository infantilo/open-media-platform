package jobs

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Echter Ablauf über NATS mit echtem ffmpeg. Nur mit OMP_E2E_NATS=nats://127.0.0.1:4222 (und installiertem ffmpeg/ffprobe);
// nutzt ein eindeutiges Subject, berührt keine Plattform-Subjects.
func TestE2ENatsMitEchtemFFmpeg(t *testing.T) {
	url := os.Getenv("OMP_E2E_NATS")
	if url == "" {
		t.Skip("OMP_E2E_NATS nicht gesetzt")
	}
	ffmpeg, err1 := exec.LookPath("ffmpeg")
	ffprobe, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("ffmpeg/ffprobe fehlen")
	}
	nc, err := nats.Connect(url)
	if err != nil {
		t.Skip("NATS nicht erreichbar: " + err.Error())
	}
	defer nc.Close()
	root := t.TempDir()
	cfg := Config{Tools: map[string]ToolConfig{"ffmpeg": {Path: ffmpeg, Nice: 15, Threads: 1}, "ffprobe": {Path: ffprobe}}, JobRoots: []string{root}, MaxJobs: 2}
	r := NewRunner(cfg, "e2e-test-host", t.TempDir(), nc)
	r.Probe()
	info := r.Info()
	if info.Tools["ffmpeg"].Version == "" || len(info.Tools["ffmpeg"].Encoders) == 0 {
		t.Fatalf("Fähigkeiten nicht ermittelt: %+v", info.Tools["ffmpeg"])
	}
	t.Logf("ffmpeg: %s, %d Encoder, Hwaccels %v", info.Tools["ffmpeg"].Version, len(info.Tools["ffmpeg"].Encoders), info.Tools["ffmpeg"].Hwaccels)

	var mu sync.Mutex
	events := map[string][]Event{}
	sub, err := nc.Subscribe("omp-job.e2e-test-host.>", func(m *nats.Msg) {
		var e Event
		if json.Unmarshal(m.Data, &e) == nil {
			mu.Lock()
			events[e.JobID] = append(events[e.JobID], e)
			mu.Unlock()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()
	waitDone := func(id string) []Event {
		for i := 0; i < 400; i++ {
			mu.Lock()
			evs := append([]Event(nil), events[id]...)
			mu.Unlock()
			if len(evs) > 0 && evs[len(evs)-1].Type == "done" {
				return evs
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("Job %s nicht fertig", id)
		return nil
	}

	src := filepath.Join(root, "in.mp4")
	if _, err := r.Exec(Request{JobID: "gen", Tool: "ffmpeg", Args: []string{"-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-pix_fmt", "yuv420p", src}}); err != nil {
		t.Fatal(err)
	}
	if d := waitDone("gen"); d[len(d)-1].ExitCode != 0 || d[len(d)-1].Error != "" {
		t.Fatalf("%+v", d[len(d)-1])
	}
	// ffprobe liefert JSON über stdout-Ereignisse
	if _, err := r.Exec(Request{JobID: "probe", Tool: "ffprobe", Args: []string{"-v", "error", "-show_format", "-of", "json", src}}); err != nil {
		t.Fatal(err)
	}
	evs := waitDone("probe")
	var out []byte
	for _, e := range evs {
		if e.Type == "stdout" {
			out = append(out, e.Data...)
		}
	}
	if !strings.Contains(string(out), `"format_name"`) {
		t.Fatalf("ffprobe-Ausgabe: %q", out)
	}
	// Transcode mit Fortschritt; Ausgabe außerhalb der Wurzel wird abgelehnt
	dst := filepath.Join(root, "out.mkv")
	if _, err := r.Exec(Request{JobID: "bad", Tool: "ffmpeg", Args: []string{"-y", "-i", src, "/tmp/omp-e2e-out.mkv"}}); err == nil {
		t.Fatal("Ausgabe außerhalb der Wurzel muss abgelehnt werden")
	}
	if _, err := r.Exec(Request{JobID: "tc", Tool: "ffmpeg", Args: []string{"-y", "-i", src, "-c:v", "mpeg4", dst}}); err != nil {
		t.Fatal(err)
	}
	if d := waitDone("tc"); d[len(d)-1].ExitCode != 0 {
		t.Fatalf("%+v", d[len(d)-1])
	}
	if st, err := os.Stat(dst); err != nil || st.Size() == 0 {
		t.Fatalf("Ergebnis fehlt: %v", err)
	}
	if len(r.List()) != 0 {
		t.Fatal("Jobliste muss leer sein")
	}
	if _, err := os.Stat(filepath.Join(r.dir, "tc")); err == nil {
		t.Fatal("Arbeitsverzeichnis muss aufgeräumt sein")
	}
}

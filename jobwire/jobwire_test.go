package jobwire

import (
	"encoding/json"
	"testing"
)

// Festgeschriebene Zeichenketten: eine Änderung am Format fällt hier auf und ist eine bewusste Entscheidung.
func TestFormat(t *testing.T) {
	b, _ := json.Marshal(Request{Action: ActionExec, Exec: Exec{JobID: "j1-1", Tool: "ffmpeg", Args: []string{"-i", "/a"}, TimeoutS: 60, Nice: 10}})
	if want := `{"action":"exec","jobId":"j1-1","tool":"ffmpeg","args":["-i","/a"],"timeoutS":60,"nice":10}`; string(b) != want {
		t.Fatalf("\n got  %s\n want %s", b, want)
	}
	b, _ = json.Marshal(Event{Type: "done", JobID: "j1-1", ExitCode: 3, Error: ErrCancelled, Tail: []string{"a"}, Chunks: 2, DurationMs: 42})
	if want := `{"type":"done","jobId":"j1-1","exitCode":3,"error":"abgebrochen","tail":["a"],"chunks":2,"durationMs":42}`; string(b) != want {
		t.Fatalf("\n got  %s\n want %s", b, want)
	}
	b, _ = json.Marshal(Event{Type: "stdout", JobID: "j", Seq: 1, Data: []byte("{}")})
	if want := `{"type":"stdout","jobId":"j","seq":1,"data":"e30=","exitCode":0}`; string(b) != want {
		t.Fatalf("%s", b)
	}
	if EventSubject("h", "j") != "omp-job.h.j" || CommandSubject("h") != "omp.host.h.cmd" || !IsAction("exec-pause") || IsAction("start") {
		t.Fatal("Subjects/Aktionen")
	}
}

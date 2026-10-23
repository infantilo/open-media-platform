package review

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// Runner startet externe Werkzeuge. Fehler (err != nil) bedeuten „konnte nicht ausgeführt werden“ (nicht gefunden,
// abgebrochen, Zeitlimit) — ein Exit-Code ≠ 0 ist dagegen ein Ergebnis des Werkzeugs und kein Ausführungsfehler.
// Das ist die Grundlage der Unterscheidung „QC nicht ausführbar“ ≠ „QC hat Fehler in den Medien gefunden“.
type Runner interface {
	Run(ctx context.Context, name string, args []string, onStderr func(line string)) (stdout []byte, exitCode int, err error)
}

// osRunner nutzt os/exec (mit nice, falls vorhanden, damit QC die Live-Nodes nicht stört).
type osRunner struct{ nice string }

func newOSRunner() *osRunner {
	p, _ := exec.LookPath("nice")
	return &osRunner{nice: p}
}

const maxStdout = 32 << 20

func (r *osRunner) Run(ctx context.Context, name string, args []string, onStderr func(string)) ([]byte, int, error) {
	var cmd *exec.Cmd
	if r.nice != "" {
		cmd = exec.CommandContext(ctx, r.nice, append([]string{"-n", "10", name}, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, name, args...)
	}
	var out bytes.Buffer
	cmd.Stdout = &limitWriter{w: &out, max: maxStdout}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, -1, err
	}
	if err := cmd.Start(); err != nil {
		return nil, -1, err
	}
	sc := bufio.NewScanner(stderr)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	// ffmpeg trennt Statuszeilen mit \r — ebenfalls als Zeilenende behandeln
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if atEOF && len(data) == 0 {
			return 0, nil, nil
		}
		if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
			return i + 1, data[:i], nil
		}
		if atEOF {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		if onStderr != nil {
			if l := sc.Text(); l != "" {
				onStderr(l)
			}
		}
	}
	_, _ = io.Copy(io.Discard, stderr)
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return out.Bytes(), -1, ctx.Err()
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		return out.Bytes(), ee.ExitCode(), nil
	}
	if waitErr != nil {
		return out.Bytes(), -1, waitErr
	}
	return out.Bytes(), 0, nil
}

type limitWriter struct {
	w   *bytes.Buffer
	max int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.w.Len() < l.max {
		room := l.max - l.w.Len()
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}

// Tools sind die Pfade und Fähigkeiten von ffmpeg/ffprobe auf diesem Host.
type Tools struct {
	FFmpeg  string
	FFprobe string
	R       Runner
	// QCJobs/ProxyJobs: optional — Jobs über den Job-Dispatcher (Host-Auswahl, Lastverteilung, Sendeschutz,
	// docs/ENTWURF-FFMPEG-HOSTWAHL.md). nil: lokal über R. Die Selbstauskunft (-version, -filters) bleibt immer lokal (R).
	QCJobs    Runner
	ProxyJobs Runner

	once     sync.Once
	versions map[string]string
	filters  map[string]bool
	discErr  error
}

// NewTools sucht ffmpeg/ffprobe im PATH (Pfade überschreibbar).
func NewTools(ffmpegPath, ffprobePath string) *Tools {
	if ffmpegPath == "" {
		ffmpegPath, _ = exec.LookPath("ffmpeg")
	}
	if ffprobePath == "" {
		ffprobePath, _ = exec.LookPath("ffprobe")
	}
	return &Tools{FFmpeg: ffmpegPath, FFprobe: ffprobePath, R: newOSRunner()}
}

// Exec: Ausführung der QC-Läufe (Klasse batch).
func (t *Tools) Exec() Runner {
	if t.QCJobs != nil {
		return t.QCJobs
	}
	return t.R
}

// ExecProxy: Ausführung für Proxy/Einzelbild (Klasse interactive).
func (t *Tools) ExecProxy() Runner {
	if t.ProxyJobs != nil {
		return t.ProxyJobs
	}
	return t.R
}

// ExecError: die Analyse konnte nicht (vollständig) ausgeführt werden.
type ExecError struct {
	Phase string
	Msg   string
}

func (e *ExecError) Error() string {
	return fmt.Sprintf("QC nicht ausführbar (%s): %s", e.Phase, e.Msg)
}

// Discover liest Versionen und die verfügbaren Filter (einmal je Prozess).
func (t *Tools) Discover(ctx context.Context) error {
	t.once.Do(func() {
		t.versions = map[string]string{}
		t.filters = map[string]bool{}
		if t.FFmpeg == "" || t.FFprobe == "" {
			t.discErr = &ExecError{Phase: "tools", Msg: "ffmpeg/ffprobe nicht gefunden (PATH)"}
			return
		}
		for name, bin := range map[string]string{"ffmpeg": t.FFmpeg, "ffprobe": t.FFprobe} {
			out, code, err := t.R.Run(ctx, bin, []string{"-hide_banner", "-version"}, nil)
			if err != nil || code != 0 {
				t.discErr = &ExecError{Phase: "tools", Msg: fmt.Sprintf("%s nicht ausführbar", name)}
				return
			}
			first := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
			t.versions[name] = parseVersion(first)
		}
		out, _, err := t.R.Run(ctx, t.FFmpeg, []string{"-hide_banner", "-filters"}, nil)
		if err != nil {
			t.discErr = &ExecError{Phase: "tools", Msg: "Filterliste nicht lesbar"}
			return
		}
		for _, l := range strings.Split(string(out), "\n") {
			f := strings.Fields(l)
			if len(f) >= 3 && len(f[0]) == 3 {
				t.filters[f[1]] = true
			}
		}
	})
	return t.discErr
}

func parseVersion(line string) string {
	f := strings.Fields(line)
	for i, w := range f {
		if w == "version" && i+1 < len(f) {
			return f[i+1]
		}
	}
	return strings.TrimSpace(line)
}

// Version eines Werkzeugs („ffmpeg“, „ffprobe“).
func (t *Tools) Version(name string) string { return t.versions[name] }

// Has: ist der Filter in diesem ffmpeg vorhanden?
func (t *Tools) Has(filter string) bool { return t.filters[filter] }

// Package jobs führt allow-gelistete Programme (ffmpeg/ffprobe) im Auftrag des Orchestrators aus
// (docs/ENTWURF-FFMPEG-HOSTWAHL.md §3.1). Der Agent entscheidet selbst, was läuft: ohne `tools.json` lehnt er jede
// Anfrage ab, Pfade müssen unter den dort genannten Wurzeln liegen, Netzprotokolle sind gesperrt, solange `allowNet` fehlt.
// Ergebnisse kommen nicht als Antwort (Jobs dauern länger als ein NATS-Request), sondern als Ereignisse auf
// `omp-job.<hostId>.<jobId>` — bewusst außerhalb von `omp.>`, damit sie nicht als SSE an Browser gehen.
package jobs

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/infantilo/openmediaplatform/jobwire"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ToolConfig beschreibt ein erlaubtes Programm.
type ToolConfig struct {
	Path    string `json:"path"`
	MaxJobs int    `json:"maxJobs,omitempty"` // 0 = Gesamtgrenze
	Nice    int    `json:"nice,omitempty"`    // Standard 10
	Threads int    `json:"threads,omitempty"` // >0: -threads N bei ffmpeg, falls der Job keinen setzt
}

// Config ist der Inhalt von tools.json.
type Config struct {
	Tools    map[string]ToolConfig `json:"tools"`
	JobRoots []string              `json:"jobRoots"`
	AllowNet bool                  `json:"allowNet,omitempty"`
	MaxJobs  int                   `json:"maxJobs,omitempty"` // Gesamtgrenze, Standard 2
	// CPUQuota: z. B. "200%" — nur wirksam, wenn systemd-run vorhanden ist.
	CPUQuota string `json:"cpuQuota,omitempty"`
}

// LoadFile liest und prüft tools.json.
func LoadFile(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return Config{}, fmt.Errorf("tools.json: %w", err)
	}
	if len(c.Tools) == 0 {
		return Config{}, errors.New("tools.json: keine Programme freigegeben")
	}
	for name, t := range c.Tools {
		if !filepath.IsAbs(t.Path) {
			return Config{}, fmt.Errorf("tools.json: %s: Pfad muss absolut sein", name)
		}
	}
	for i, r := range c.JobRoots {
		if !filepath.IsAbs(r) {
			return Config{}, fmt.Errorf("tools.json: jobRoots[%d] muss absolut sein", i)
		}
		c.JobRoots[i] = filepath.Clean(r)
	}
	if c.MaxJobs <= 0 {
		c.MaxJobs = 2
	}
	return c, nil
}

// Request ist, was der Executor an Runner.Exec reicht.
type Request struct {
	JobID    string
	Tool     string
	Args     []string
	TimeoutS int
	Nice     int // 0 = Standard des Programms
}

// Event ist die auf jobwire.EventSubject veröffentlichte Nachricht (gemeinsames Wire-Format).
type Event = jobwire.Event

// Publisher ist die genutzte Teilmenge von *nats.Conn.
type Publisher interface {
	Publish(subject string, data []byte) error
}

// Info, ToolInfo, JobInfo: gemeinsames Wire-Format (jobwire).
type (
	Info     = jobwire.Info
	ToolInfo = jobwire.ToolInfo
	JobInfo  = jobwire.JobInfo
)

type running struct {
	cmd       *exec.Cmd
	tool      string
	paused    bool
	cancelled bool
}

// Runner führt Jobs aus.
type Runner struct {
	cfg    Config
	hostID string
	pub    Publisher
	dir    string // Arbeitsverzeichnis-Wurzel

	mu   sync.Mutex
	jobs map[string]*running
	info map[string]ToolInfo
}

// NewRunner legt den Runner an; dir ist die Wurzel der Job-Arbeitsverzeichnisse.
func NewRunner(cfg Config, hostID, dir string, pub Publisher) *Runner {
	return &Runner{cfg: cfg, hostID: hostID, pub: pub, dir: dir, jobs: map[string]*running{}, info: map[string]ToolInfo{}}
}

var schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.\-]*:`)
var netSchemes = map[string]bool{"http": true, "https": true, "rtmp": true, "rtmps": true, "rtsp": true, "rtp": true, "srt": true, "udp": true, "tcp": true, "tls": true, "ftp": true, "sftp": true, "rist": true, "mmsh": true, "mmst": true, "hls": true, "ftps": true, "gopher": true, "icecast": true, "unix": true, "sctp": true}

// RejectError: die Anfrage verstößt gegen die lokale Freigabe (dauerhaft, nicht vorübergehend).
type RejectError struct{ Msg string }

func (e *RejectError) Error() string { return e.Msg }

func reject(format string, a ...any) error { return &RejectError{Msg: fmt.Sprintf(format, a...)} }

// Validate prüft Programm und Argumente gegen die lokale Freigabe und liefert den endgültigen Argumentvektor.
func (r *Runner) Validate(tool string, args []string) ([]string, error) {
	tc, ok := r.cfg.Tools[tool]
	if !ok {
		return nil, reject("Programm %q ist auf diesem Host nicht freigegeben", tool)
	}
	for i, a := range args {
		if strings.ContainsRune(a, 0) {
			return nil, reject("Argument %d enthält ein Nullzeichen", i)
		}
		if filepath.IsAbs(a) {
			if !r.underRoot(a) {
				return nil, reject("Pfad %q liegt außerhalb der erlaubten Wurzeln", a)
			}
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if m := schemeRe.FindString(a); m != "" && len(m) > 2 { // "c:" (Laufwerk) / "v:0" ausnehmen: Schema ≥ 2 Zeichen
			name := strings.ToLower(strings.TrimSuffix(m, ":"))
			if name == "file" {
				p := strings.TrimPrefix(a, m)
				p = strings.TrimPrefix(p, "//")
				if filepath.IsAbs(p) && !r.underRoot(p) {
					return nil, reject("Pfad %q liegt außerhalb der erlaubten Wurzeln", p)
				}
				continue
			}
			if !r.cfg.AllowNet && (netSchemes[name] || name == "concat" || name == "subfile" || name == "crypto" || name == "async" || name == "cache" || name == "data") {
				return nil, reject("Protokoll %q ist auf diesem Host nicht freigegeben (allowNet)", name)
			}
			continue
		}
		// Filter-Argumente können Dateien nennen (movie=, subtitles=, …): absolute Pfade darin prüfen.
		for _, p := range embeddedAbsPaths(a) {
			if !r.underRoot(p) {
				return nil, reject("Pfad %q (in %q) liegt außerhalb der erlaubten Wurzeln", p, a)
			}
		}
	}
	out := make([]string, 0, len(args)+8)
	switch tool {
	case "ffmpeg", "ffprobe":
		if tool == "ffmpeg" {
			out = append(out, "-nostdin", "-hide_banner")
		} else if !r.cfg.AllowNet { // ffprobe kennt weder -nostdin noch -hide_banner
			out = append(out, "-protocol_whitelist", "file,pipe")
		}
		hasThreads := false
		for _, a := range args {
			if a == "-threads" {
				hasThreads = true
			}
		}
		if tool == "ffmpeg" && tc.Threads > 0 && !hasThreads {
			out = append(out, "-threads", fmt.Sprint(tc.Threads))
		}
		for _, a := range args {
			if tool == "ffmpeg" && !r.cfg.AllowNet && a == "-i" {
				out = append(out, "-protocol_whitelist", "file,pipe")
			}
			out = append(out, a)
		}
	default:
		out = append(out, args...)
	}
	return out, nil
}

var embeddedPathRe = regexp.MustCompile(`(?:^|[=:,;'"\s\[])(/[^\s,;:'"\]]+)`)

func embeddedAbsPaths(a string) []string {
	var out []string
	for _, m := range embeddedPathRe.FindAllStringSubmatch(a, -1) {
		out = append(out, m[1])
	}
	return out
}

// underRoot: Pfad liegt (nach Auflösen von Symlinks des vorhandenen Anteils) unter einer erlaubten Wurzel.
func (r *Runner) underRoot(p string) bool {
	p = filepath.Clean(p)
	rp := resolveExisting(p)
	for _, root := range r.cfg.JobRoots {
		rr := resolveExisting(root)
		if rp == rr || strings.HasPrefix(rp, rr+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// resolveExisting löst Symlinks des längsten vorhandenen Präfixes auf (Ausgabedateien existieren noch nicht).
func resolveExisting(p string) string {
	rest := ""
	cur := p
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

func (r *Runner) subject(jobID string) string { return jobwire.EventSubject(r.hostID, jobID) }

func (r *Runner) emit(jobID string, ev Event) {
	if r.pub == nil {
		return
	}
	ev.JobID = jobID
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if err := r.pub.Publish(r.subject(jobID), b); err != nil {
		slog.Warn("jobs: publish failed", "job", jobID, "error", err)
	}
}

const stdoutChunk = 512 << 10
const maxStdout = 32 << 20

// Exec validiert und startet den Job; die Antwort (PID) kommt sofort, alles Weitere als Ereignisse.
func (r *Runner) Exec(req Request) (pid int, err error) {
	if req.JobID == "" || strings.ContainsAny(req.JobID, ".*> /") {
		return 0, errors.New("ungültige jobId")
	}
	args, err := r.Validate(req.Tool, req.Args)
	if err != nil {
		return 0, err
	}
	tc := r.cfg.Tools[req.Tool]
	r.mu.Lock()
	if _, dup := r.jobs[req.JobID]; dup {
		r.mu.Unlock()
		return 0, errors.New("jobId läuft bereits")
	}
	if len(r.jobs) >= r.cfg.MaxJobs {
		r.mu.Unlock()
		return 0, fmt.Errorf("Job-Grenze dieses Hosts erreicht (%d)", r.cfg.MaxJobs)
	}
	if tc.MaxJobs > 0 {
		n := 0
		for _, j := range r.jobs {
			if j.tool == req.Tool {
				n++
			}
		}
		if n >= tc.MaxJobs {
			r.mu.Unlock()
			return 0, fmt.Errorf("Grenze für %s erreicht (%d)", req.Tool, tc.MaxJobs)
		}
	}
	r.mu.Unlock()

	nice := tc.Nice
	if nice == 0 {
		nice = 10
	}
	if req.Nice > 0 {
		nice = req.Nice
	}
	if nice > 19 {
		nice = 19
	}
	workDir := filepath.Join(r.dir, req.JobID)
	if err := os.MkdirAll(workDir, 0o750); err != nil {
		return 0, err
	}
	argv := r.wrap(tc.Path, args, nice)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = workDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(workDir)
		return 0, err
	}
	// PID-Datei: nach einem harten Absturz des Agents findet CleanupStale die verwaisten Prozesse wieder
	_ = os.WriteFile(filepath.Join(workDir, "pid"), []byte(fmt.Sprint(cmd.Process.Pid)), 0o640)
	run := &running{cmd: cmd, tool: req.Tool}
	r.mu.Lock()
	r.jobs[req.JobID] = run
	r.mu.Unlock()
	pid = cmd.Process.Pid
	// Der Wrapper (nice/ionice/systemd-run) kann zusätzliche Ebenen haben; Setpgid fasst den ganzen Baum.
	go r.watch(req, run, stdout, stderr, workDir)
	return pid, nil
}

// wrap setzt nice/ionice/systemd-run vor das Programm (soweit vorhanden); fehlende Hilfsprogramme werden übersprungen.
func (r *Runner) wrap(bin string, args []string, nice int) []string {
	argv := append([]string{bin}, args...)
	if p, err := exec.LookPath("ionice"); err == nil {
		argv = append([]string{p, "-c3"}, argv...)
	}
	if p, err := exec.LookPath("nice"); err == nil {
		argv = append([]string{p, "-n", fmt.Sprint(nice)}, argv...)
	}
	if r.cfg.CPUQuota != "" {
		if p, err := exec.LookPath("systemd-run"); err == nil && os.Getenv("OMP_HOST_AGENT_NO_SYSTEMD_RUN") == "" {
			argv = append([]string{p, "--user", "--scope", "--quiet", "-p", "CPUQuota=" + r.cfg.CPUQuota, "-p", "OOMScoreAdjust=800"}, argv...)
		}
	}
	return argv
}

func (r *Runner) watch(req Request, run *running, stdout, stderr io.ReadCloser, workDir string) {
	start := time.Now()
	r.emit(req.JobID, Event{Type: "started", PID: run.cmd.Process.Pid})

	var timer *time.Timer
	timedOut := false
	if req.TimeoutS > 0 {
		timer = time.AfterFunc(time.Duration(req.TimeoutS)*time.Second, func() {
			r.mu.Lock()
			timedOut = true
			r.mu.Unlock()
			r.kill(run)
		})
	}

	var tail []string
	var tailMu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		sc.Split(splitCRLF)
		lastProgress := time.Time{}
		for sc.Scan() {
			l := sc.Text()
			if l == "" {
				continue
			}
			tailMu.Lock()
			tail = append(tail, l)
			if len(tail) > 40 {
				tail = tail[len(tail)-40:]
			}
			tailMu.Unlock()
			if time.Since(lastProgress) >= time.Second {
				lastProgress = time.Now()
				r.emit(req.JobID, Event{Type: "progress", Line: l})
			}
		}
		_, _ = io.Copy(io.Discard, stderr)
	}()
	var chunks int
	go func() {
		defer wg.Done()
		var total int
		buf := make([]byte, stdoutChunk)
		for {
			n, err := io.ReadFull(stdout, buf)
			if n > 0 && total < maxStdout {
				chunks++
				total += n
				r.emit(req.JobID, Event{Type: "stdout", Seq: chunks, Data: append([]byte(nil), buf[:n]...)})
			}
			if err != nil {
				_, _ = io.Copy(io.Discard, stdout)
				return
			}
		}
	}()
	wg.Wait()
	waitErr := run.cmd.Wait()
	if timer != nil {
		timer.Stop()
	}

	r.mu.Lock()
	delete(r.jobs, req.JobID)
	cancelled := run.cancelled
	to := timedOut
	r.mu.Unlock()
	_ = os.RemoveAll(workDir)

	ev := Event{Type: "done", Chunks: chunks, DurationMs: time.Since(start).Milliseconds()}
	tailMu.Lock()
	ev.Tail = append([]string(nil), tail...)
	tailMu.Unlock()
	var ee *exec.ExitError
	switch {
	case errors.As(waitErr, &ee):
		ev.ExitCode = ee.ExitCode()
		if ee.ExitCode() < 0 { // durch Signal beendet
			ev.ExitCode = -1
		}
	case waitErr != nil:
		ev.ExitCode = -1
		ev.Error = waitErr.Error()
	}
	if cancelled {
		ev.Error = jobwire.ErrCancelled
		ev.ExitCode = -1
	} else if to {
		ev.Error = jobwire.ErrTimeout
		ev.ExitCode = -1
	}
	r.emit(req.JobID, ev)
}

func splitCRLF(data []byte, atEOF bool) (int, []byte, error) {
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
}

func (r *Runner) kill(run *running) {
	pgid := -run.cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGCONT) // ein pausierter Job muss das Signal zustellen können
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	time.AfterFunc(3*time.Second, func() { _ = syscall.Kill(pgid, syscall.SIGKILL) })
}

// Cancel bricht einen Job ab (SIGTERM, nach 3 s SIGKILL).
func (r *Runner) Cancel(jobID string) error {
	r.mu.Lock()
	run, ok := r.jobs[jobID]
	if ok {
		run.cancelled = true
	}
	r.mu.Unlock()
	if !ok {
		return errors.New("Job unbekannt")
	}
	r.kill(run)
	return nil
}

// Pause hält einen Job an (SIGSTOP) bzw. setzt ihn fort (SIGCONT).
func (r *Runner) Pause(jobID string, on bool) error {
	r.mu.Lock()
	run, ok := r.jobs[jobID]
	if ok {
		run.paused = on
	}
	r.mu.Unlock()
	if !ok {
		return errors.New("Job unbekannt")
	}
	sig := syscall.SIGCONT
	if on {
		sig = syscall.SIGSTOP
	}
	return syscall.Kill(-run.cmd.Process.Pid, sig)
}

// Renice setzt die Priorität des ganzen Job-Prozessbaums.
func (r *Runner) Renice(jobID string, nice int) error {
	if nice < 0 || nice > 19 {
		return errors.New("nice 0–19")
	}
	r.mu.Lock()
	run, ok := r.jobs[jobID]
	r.mu.Unlock()
	if !ok {
		return errors.New("Job unbekannt")
	}
	return syscall.Setpriority(syscall.PRIO_PGRP, run.cmd.Process.Pid, nice)
}

// List liefert die laufenden Jobs.
func (r *Runner) List() []JobInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]JobInfo, 0, len(r.jobs))
	for id, j := range r.jobs {
		out = append(out, JobInfo{JobID: id, Tool: j.tool, PID: j.cmd.Process.Pid, Paused: j.paused})
	}
	sort.Slice(out, func(i, k int) bool { return out[i].JobID < out[k].JobID })
	return out
}

// Info ist die Fähigkeitsmeldung für die Telemetrie.
func (r *Runner) Info() *Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	tools := make(map[string]ToolInfo, len(r.cfg.Tools))
	for n := range r.cfg.Tools {
		tools[n] = r.info[n]
	}
	return &Info{Tools: tools, JobRoots: r.cfg.JobRoots, MaxJobs: r.cfg.MaxJobs, JobsRunning: len(r.jobs), AllowNet: r.cfg.AllowNet}
}

// Probe ermittelt Version, Encoder, Decoder und Hwaccels der freigegebenen Programme (einmal beim Start).
func (r *Runner) Probe() {
	for name, tc := range r.cfg.Tools {
		if name != "ffmpeg" && name != "ffprobe" {
			continue
		}
		ti := ToolInfo{}
		if out, err := exec.Command(tc.Path, "-hide_banner", "-version").Output(); err == nil {
			if i := bytes.IndexByte(out, '\n'); i > 0 {
				ti.Version = strings.TrimSpace(string(out[:i]))
			}
		}
		if name == "ffmpeg" {
			ti.Encoders = listNames(tc.Path, "-encoders")
			ti.Decoders = listNames(tc.Path, "-decoders")
			ti.Hwaccels = hwaccels(tc.Path)
		}
		r.mu.Lock()
		r.info[name] = ti
		r.mu.Unlock()
	}
}

func listNames(bin, flag string) []string {
	out, err := exec.Command(bin, "-hide_banner", flag).Output()
	if err != nil {
		return nil
	}
	var names []string
	started := false
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "------") {
			started = true
			continue
		}
		if !started {
			continue
		}
		f := strings.Fields(l)
		if len(f) >= 2 && len(f[0]) >= 6 {
			names = append(names, f[1])
		}
	}
	return names
}

func hwaccels(bin string) []string {
	out, err := exec.Command(bin, "-hide_banner", "-hwaccels").Output()
	if err != nil {
		return nil
	}
	var res []string
	for i, l := range strings.Split(string(out), "\n") {
		l = strings.TrimSpace(l)
		if i == 0 || l == "" {
			continue
		}
		res = append(res, l)
	}
	return res
}

// Shutdown beendet alle laufenden Jobs (Agent wird beendet) und wartet kurz, bis ihre Abschluss-Ereignisse veröffentlicht sind —
// der Orchestrator plant sie dann auf einem anderen Host neu, statt dass Prozesse ohne Agent weiterlaufen.
func (r *Runner) Shutdown(wait time.Duration) {
	r.mu.Lock()
	var runs []*running
	for _, j := range r.jobs {
		j.cancelled = true
		runs = append(runs, j)
	}
	r.mu.Unlock()
	for _, j := range runs {
		r.kill(j)
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		n := len(r.jobs)
		r.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// CleanupStale beendet beim Start des Agents Job-Prozesse, die ein abgestürzter Vorgänger zurückgelassen hat (SIGKILL/Absturz
// lässt Kindprozesse weiterlaufen), und räumt deren Arbeitsverzeichnisse auf. Es werden nur Prozesse beendet, deren Kommandozeile
// ein freigegebenes Programm enthält — eine wiederverwendete PID trifft so kein fremdes Programm. Liefert die Anzahl beendeter Jobs.
func (r *Runner) CleanupStale() int {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return 0
	}
	killed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(r.dir, e.Name())
		if b, err := os.ReadFile(filepath.Join(dir, "pid")); err == nil {
			var pid int
			if _, err := fmt.Sscan(strings.TrimSpace(string(b)), &pid); err == nil && pid > 1 && r.isJobProcess(pid) {
				_ = syscall.Kill(-pid, syscall.SIGCONT)
				_ = syscall.Kill(-pid, syscall.SIGTERM)
				time.AfterFunc(3*time.Second, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
				killed++
				slog.Warn("jobs: verwaisten Job-Prozess eines früheren Agents beendet", "job", e.Name(), "pid", pid)
			}
		}
		_ = os.RemoveAll(dir)
	}
	return killed
}

func (r *Runner) isJobProcess(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	cmd := string(b)
	for _, t := range r.cfg.Tools {
		if strings.Contains(cmd, t.Path) {
			return true
		}
	}
	return false
}

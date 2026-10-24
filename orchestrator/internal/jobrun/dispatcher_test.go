package jobrun

import (
	"context"
	"encoding/json"
	"errors"
	hostsp "github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeHosts struct {
	mu sync.Mutex
	hs []HostState
}

func (f *fakeHosts) Hosts() []HostState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]HostState(nil), f.hs...)
}

func (f *fakeHosts) set(id string, fn func(*HostState)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.hs {
		if f.hs[i].ID == id {
			fn(&f.hs[i])
		}
	}
}

func localHost(cpu float64) HostState {
	h := host(LocalHostID, cpu)
	h.Local = true
	h.CPUCores = 4
	return h
}

func script(t *testing.T, body string) func(string) string {
	p := filepath.Join(t.TempDir(), "tool.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return func(string) string { return p }
}

func startLoop(t *testing.T, d *Dispatcher) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go d.Loop(ctx)
}

func testConfig(c *Config) func() Config {
	return func() Config { return *c }
}

func TestLokalerLauf(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `echo '{"a":1}'; echo fortschritt >&2; exit 2`)
	startLoop(t, d)
	var lines []string
	var mu sync.Mutex
	res := d.Run(context.Background(), Spec{Caller: "qc", Tool: "ffprobe", Args: []string{"x"}, OnStderr: func(l string) { mu.Lock(); lines = append(lines, l); mu.Unlock() }})
	if res.Err != nil || res.ExitCode != 2 || strings.TrimSpace(string(res.Stdout)) != `{"a":1}` || res.Host != LocalHostID {
		t.Fatalf("%+v", res)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(lines) != 1 || lines[0] != "fortschritt" {
		t.Fatalf("stderr: %v", lines)
	}
	j := d.List(StateDone)
	if len(j) != 1 || j[0].Placement == nil || j[0].Placement.Host != LocalHostID {
		t.Fatalf("%+v", j)
	}
}

func TestNichtInstalliertUndUnbekanntesProgramm(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.MaxAttempts = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = func(string) string { return "" }
	startLoop(t, d)
	if res := d.Run(context.Background(), Spec{Tool: "ffmpeg"}); res.Err == nil || !strings.Contains(res.Err.Error(), "nicht installiert") {
		t.Fatalf("%+v", res)
	}
	if _, err := d.Submit(Spec{Tool: "rm"}); err == nil {
		t.Fatal("nur ffmpeg/ffprobe")
	}
	if _, err := d.Submit(Spec{Tool: "ffmpeg", Target: "quatsch"}); err == nil {
		t.Fatal("ungültiges Ziel")
	}
}

func TestWartenBisPlatzFrei(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.Local.MaxJobs = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 0.6`)
	startLoop(t, d)
	a, _ := d.Submit(Spec{Tool: "ffmpeg"})
	b, _ := d.Submit(Spec{Tool: "ffmpeg"})
	time.Sleep(250 * time.Millisecond)
	ja, _ := d.Get(a)
	jb, _ := d.Get(b)
	if ja.State != StateRunning || jb.State != StateQueued || !strings.Contains(jb.Wait, "Job-Plätze") {
		t.Fatalf("a=%s b=%s wait=%q", ja.State, jb.State, jb.Wait)
	}
	if r := d.Wait(context.Background(), b); r.Err != nil {
		t.Fatal(r.Err)
	}
	if run, wait := d.Counts(); run != 0 || wait != 0 {
		t.Fatalf("%d %d", run, wait)
	}
}

func TestAbbruchWartenderUndLaufender(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.Local.MaxJobs = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 30`)
	startLoop(t, d)
	a, _ := d.Submit(Spec{Tool: "ffmpeg"})
	b, _ := d.Submit(Spec{Tool: "ffmpeg"})
	time.Sleep(300 * time.Millisecond)
	if err := d.Cancel(b); err != nil {
		t.Fatal(err)
	}
	if err := d.Cancel(a); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{a, b} {
		r := d.Wait(context.Background(), id)
		if !errors.Is(r.Err, context.Canceled) {
			t.Fatalf("%s: %+v", id, r)
		}
		if j, _ := d.Get(id); j.State != StateCancelled {
			t.Fatalf("%s: %s", id, j.State)
		}
	}
	// ctx-Abbruch bricht den Job ab
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if r := d.Run(ctx, Spec{Tool: "ffmpeg"}); r.Err == nil {
		t.Fatal("Abbruch über ctx")
	}
}

func TestZeitlimitOhneWiederholung(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 30`)
	startLoop(t, d)
	r := d.Run(context.Background(), Spec{Tool: "ffmpeg", TimeoutS: 1})
	if !errors.Is(r.Err, errTimeout) {
		t.Fatalf("%+v", r)
	}
	if j := d.List(StateFailed); len(j) != 1 || j[0].Attempt != 1 {
		t.Fatalf("keine Wiederholung bei Zeitlimit: %+v", j)
	}
}

// --- Agent-Simulation ----------------------------------------------------------------------------------

type fakeBus struct {
	mu     sync.Mutex
	subs   map[string]func([]byte)
	execs  []agentRequest
	onExec func(b *fakeBus, host string, r agentRequest) agentResponse
	cmds   []string
}

func newBus() *fakeBus { return &fakeBus{subs: map[string]func([]byte){}} }

func (b *fakeBus) Request(subject string, data []byte, _ time.Duration) ([]byte, error) {
	var r agentRequest
	_ = json.Unmarshal(data, &r)
	host := strings.TrimSuffix(strings.TrimPrefix(subject, "omp.host."), ".cmd")
	b.mu.Lock()
	b.cmds = append(b.cmds, host+":"+r.Action)
	if r.Action == "exec" {
		b.execs = append(b.execs, r)
	}
	fn := b.onExec
	b.mu.Unlock()
	resp := agentResponse{OK: true}
	if r.Action == "exec" && fn != nil {
		resp = fn(b, host, r)
	}
	return json.Marshal(resp)
}

func (b *fakeBus) Subscribe(subject string, cb func([]byte)) (func(), error) {
	b.mu.Lock()
	b.subs[subject] = cb
	b.mu.Unlock()
	return func() {}, nil
}

func (b *fakeBus) emit(host, jobID string, ev agentEvent) {
	b.mu.Lock()
	cb := b.subs["omp-job."+host+"."+jobID]
	b.mu.Unlock()
	if cb != nil {
		ev.JobID = jobID
		data, _ := json.Marshal(ev)
		cb(data)
	}
}

func (b *fakeBus) count(prefix string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.cmds {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func agentHost(id string, roots ...string) HostState {
	h := host(id, 10)
	h.Roots = roots
	h.CPUCores = 8
	return h
}

func TestAgentLaufMitPfadUmschreibungUndAtomarem(t *testing.T) {
	dir := t.TempDir()
	hostRoot := t.TempDir()
	hosts := &fakeHosts{hs: []HostState{localHost(5), agentHost("a", hostRoot)}}
	cfg := DefaultConfig()
	cfg.PathMap = map[string]map[string]string{dir: {"a": hostRoot}}
	d := New(testConfig(&cfg), hosts)
	bus := newBus()
	d.Bus = bus
	d.CheckPath = func(h, p, k string) (bool, string) { return true, "" }
	in := filepath.Join(dir, "in.mxf")
	out := filepath.Join(dir, "out.mp4")
	_ = os.WriteFile(in, []byte("x"), 0o644)
	bus.onExec = func(b *fakeBus, host string, r agentRequest) agentResponse {
		go func() {
			time.Sleep(50 * time.Millisecond)
			// der Agent schreibt die Teildatei (gemeinsamer Speicher: gleicher Ort, Orchestrator-Sicht)
			_ = os.WriteFile(filepath.Join(dir, "out.part1.mp4"), []byte("video"), 0o644)
			b.emit(host, r.JobID, agentEvent{Type: "progress", Line: "frame=1"})
			b.emit(host, r.JobID, agentEvent{Type: "stdout", Seq: 1, Data: []byte("{}")})
			b.emit(host, r.JobID, agentEvent{Type: "done", ExitCode: 0, Chunks: 1, Tail: []string{"fertig"}})
		}()
		return agentResponse{OK: true, PID: 7}
	}
	startLoop(t, d)
	res := d.Run(context.Background(), Spec{Caller: "script", Tool: "ffmpeg", Target: "host:a", Args: []string{"-i", in, out}, Inputs: []string{in}, Outputs: []string{out}, Atomic: true})
	if res.Err != nil || res.ExitCode != 0 || res.Host != "a" || string(res.Stdout) != "{}" {
		t.Fatalf("%+v", res)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("Ergebnis muss umbenannt sein: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out.part1.mp4")); err == nil {
		t.Fatal("Teildatei darf nicht bleiben")
	}
	bus.mu.Lock()
	defer bus.mu.Unlock()
	got := bus.execs[0].Args
	if got[1] != filepath.Join(hostRoot, "in.mxf") || got[2] != filepath.Join(hostRoot, "out.part1.mp4") {
		t.Fatalf("Pfade nicht umgeschrieben: %v", got)
	}
}

func TestAgentPfadNichtSichtbar(t *testing.T) {
	dir := t.TempDir()
	hosts := &fakeHosts{hs: []HostState{agentHost("a", "/srv")}}
	cfg := DefaultConfig()
	d := New(testConfig(&cfg), hosts)
	d.Bus = newBus()
	startLoop(t, d)
	id, _ := d.Submit(Spec{Tool: "ffmpeg", Target: "host:a", Inputs: []string{filepath.Join(dir, "x")}})
	time.Sleep(700 * time.Millisecond)
	j, _ := d.Get(id)
	if j.State != StateQueued || !strings.Contains(j.Wait, "pathMap") {
		t.Fatalf("%s %q", j.State, j.Wait)
	}
}

func TestHostVerlustFuehrtZuWiederholung(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{agentHost("a", "/"), agentHost("b", "/")}}
	hosts.hs[1].CPUPercent = 40 // a gewinnt zuerst
	cfg := DefaultConfig()
	d := New(testConfig(&cfg), hosts)
	bus := newBus()
	d.Bus = bus
	d.CheckPath = func(h, p, k string) (bool, string) { return true, "" }
	bus.onExec = func(b *fakeBus, host string, r agentRequest) agentResponse {
		if host == "b" {
			go func() {
				time.Sleep(30 * time.Millisecond)
				b.emit(host, r.JobID, agentEvent{Type: "done", ExitCode: 0})
			}()
		}
		return agentResponse{OK: true}
	}
	startLoop(t, d)
	id, _ := d.Submit(Spec{Tool: "ffprobe", Target: "auto", Args: []string{"x"}})
	time.Sleep(500 * time.Millisecond)
	if j, _ := d.Get(id); j.Host != "a" || j.State != StateRunning {
		t.Fatalf("erst auf a: %+v", j)
	}
	hosts.set("a", func(h *HostState) { h.Online = false })
	r := d.Wait(context.Background(), id)
	if r.Err != nil || r.Host != "b" {
		t.Fatalf("%+v", r)
	}
	j, _ := d.Get(id)
	if j.Attempt != 2 || len(j.Exclude) != 1 || j.Exclude[0] != "a" {
		t.Fatalf("%+v", j)
	}
}

func TestAgentLehntAb(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{agentHost("a", "/")}}
	cfg := DefaultConfig()
	cfg.MaxAttempts = 1
	d := New(testConfig(&cfg), hosts)
	bus := newBus()
	d.Bus = bus
	d.CheckPath = func(h, p, k string) (bool, string) { return true, "" }
	bus.onExec = func(*fakeBus, string, agentRequest) agentResponse {
		return agentResponse{OK: false, Error: "Programm nicht freigegeben"}
	}
	startLoop(t, d)
	r := d.Run(context.Background(), Spec{Tool: "ffmpeg", Target: "host:a"})
	if r.Err == nil || !strings.Contains(r.Err.Error(), "nicht freigegeben") {
		t.Fatalf("%+v", r)
	}
}

// --- Sendeschutz im Dispatcher -------------------------------------------------------------------------

func TestSendeschutzPausiertUndSetztFort(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.Protect.IntervalS = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 4; echo fertig`)
	startLoop(t, d)
	id, _ := d.Submit(Spec{Tool: "ffmpeg", Class: ClassBatch})
	time.Sleep(700 * time.Millisecond)
	hosts.set(LocalHostID, func(h *HostState) { h.CPUPercent = 72 }) // Grenze 70 %
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j, _ := d.Get(id); j.Paused {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if j, _ := d.Get(id); !j.Paused {
		t.Fatalf("Job muss pausiert sein: %+v", j.Events)
	}
	hosts.set(LocalHostID, func(h *HostState) { h.CPUPercent = 20 })
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j, _ := d.Get(id); !j.Paused {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	r := d.Wait(context.Background(), id)
	j, _ := d.Get(id)
	if r.Err != nil || j.Paused || strings.TrimSpace(string(r.Stdout)) != "fertig" {
		t.Fatalf("%+v %+v", r, j.Events)
	}
	kinds := ""
	for _, e := range j.Events {
		kinds += e.Kind + " "
	}
	if !strings.Contains(kinds, "pause") || !strings.Contains(kinds, "resume") {
		t.Fatalf("Ereignisse: %s", kinds)
	}
}

func TestSendeschutzBrichtAbUndPlantNeu(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.Protect.IntervalS = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 1; echo ok`)
	var degraded bool
	var dm sync.Mutex
	d.Degraded = func(string) bool { dm.Lock(); defer dm.Unlock(); return degraded }
	startLoop(t, d)
	dm.Lock()
	degraded = true
	dm.Unlock()
	id, _ := d.Submit(Spec{Tool: "ffmpeg", Class: ClassBatch})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j, _ := d.Get(id); len(j.Events) > 0 && hasKind(j, "protect-cancel") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	j, _ := d.Get(id)
	if !hasKind(j, "protect-cancel") {
		t.Fatalf("Abbruch erwartet: %+v", j.Events)
	}
	dm.Lock()
	degraded = false
	dm.Unlock()
	r := d.Wait(context.Background(), id)
	if r.Err != nil || strings.TrimSpace(string(r.Stdout)) != "ok" {
		t.Fatalf("nach Entwarnung neu eingeplant und fertig: %+v", r)
	}
}

func hasKind(j Job, k string) bool {
	for _, e := range j.Events {
		if e.Kind == k {
			return true
		}
	}
	return false
}

func TestSchutzLaeuftNichtGegenInteraktive(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.Protect.IntervalS = 1
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `sleep 1.5`)
	startLoop(t, d)
	id, _ := d.Submit(Spec{Tool: "ffmpeg", Class: ClassInteractive})
	time.Sleep(600 * time.Millisecond)
	hosts.set(LocalHostID, func(h *HostState) { h.CPUPercent = 72 })
	r := d.Wait(context.Background(), id)
	j, _ := d.Get(id)
	if r.Err != nil || j.Paused || hasKind(j, "pause") || hasKind(j, "protect-cancel") {
		t.Fatalf("interaktiv wird nur gedrosselt: %+v %+v", r, j.Events)
	}
}

func TestInferPathsUndPathMap(t *testing.T) {
	in, out := InferPaths("ffmpeg", []string{"-nostdin", "-i", "/m/a.mxf", "-c:v", "libx264", "/m/o.mp4"})
	if len(in) != 1 || in[0] != "/m/a.mxf" || len(out) != 1 || out[0] != "/m/o.mp4" {
		t.Fatalf("%v %v", in, out)
	}
	in, out = InferPaths("ffmpeg", []string{"-i", "/m/a.mxf", "-f", "null", "-"})
	if len(in) != 1 || len(out) != 0 {
		t.Fatalf("%v %v", in, out)
	}
	in, _ = InferPaths("ffprobe", []string{"-of", "json", "/m/a.mxf"})
	if len(in) != 1 {
		t.Fatalf("%v", in)
	}
	cfg := DefaultConfig()
	cfg.PathMap = map[string]map[string]string{"/data": {"a": "/mnt/media"}, "/data/special": {"a": "/mnt/sp"}}
	if p, ok := MapPath(cfg, "a", "/data/x/y.mxf"); !ok || p != "/mnt/media/x/y.mxf" {
		t.Fatalf("%s %v", p, ok)
	}
	if p, _ := MapPath(cfg, "a", "/data/special/z"); p != "/mnt/sp/z" {
		t.Fatalf("längster Präfix: %s", p)
	}
	if p, ok := MapPath(cfg, "b", "/data/x"); ok || p != "/data/x" {
		t.Fatalf("anderer Host: %s %v", p, ok)
	}
	if p, ok := MapPath(cfg, "a", "/database/x"); ok {
		t.Fatalf("Präfix nur an Pfadgrenze: %s", p)
	}
}

func TestAutoKalibrierungWirktAufZuweisung(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	hosts.hs[0].CPUCores = 8
	cfg := DefaultConfig()
	cfg.Calibration.Mode = "auto"
	d := New(testConfig(&cfg), hosts)
	// 8 Kerne, Live-Nodes brauchen P95 4 Kerne / Spitze 5 Kerne → Reserve max(50, 0,75·62,5) + 10 = 60 % (Obergrenze)
	d.Demand = func(string, time.Duration) (hostsp.LiveDemand, bool) {
		return hostsp.LiveDemand{Span: 48 * time.Hour, Samples: 5000, CPUNow: 3, CPUP95: 4, CPUPeak: 5, MemP95: 20, MemPeak: 25}, true
	}
	d.refreshCalibration(cfg)
	cal := d.Calibrations()
	if len(cal) != 1 || !cal[0].Enough || cal[0].Source != "auto" || cal[0].Applied.CPU != 0.60 {
		t.Fatalf("%+v", cal)
	}
	// CPU 45 %: mit Standardreserve (30 %, Batch-Grenze 56 %) möglich, mit der kalibrierten 60 % (Grenze 32 %) nicht
	hosts.set(LocalHostID, func(h *HostState) { h.CPUPercent = 45 })
	d.mu.Lock()
	st := d.statesLocked(cfg)
	d.mu.Unlock()
	dec := Place(Spec{Tool: "ffmpeg", Class: ClassBatch}, Target{Kind: "local"}, st, cfg, PlaceCtx{})
	if dec.Host != "" || !strings.Contains(dec.Reason, "Live-Reserve CPU") {
		t.Fatalf("kalibrierte Reserve muss greifen: %+v", dec)
	}
	// Host-Vorgabe schlägt Auto
	cfg.Local.Reserve = &Reserve{CPU: 0.2, Mem: 0.2, GPU: 0.2, Net: 0.2}
	d.mu.Lock()
	st = d.statesLocked(cfg)
	d.mu.Unlock()
	if dec := Place(Spec{Tool: "ffmpeg", Class: ClassBatch}, Target{Kind: "local"}, st, cfg, PlaceCtx{}); dec.Host != LocalHostID {
		t.Fatalf("Host-Reserve 20 %%: %+v", dec)
	}
	if got := d.Calibrations()[0]; got.Source != "host" || got.Applied.CPU != 0.2 {
		t.Fatalf("%+v", got)
	}
	// manuell: Vorschlag wird angezeigt, aber nicht angewendet
	cfg.Local.Reserve = nil
	cfg.Calibration.Mode = "manual"
	if got := d.Calibrations()[0]; got.Source != "config" || got.Applied.CPU != 0.30 || got.Suggested.CPU != 0.60 {
		t.Fatalf("%+v", got)
	}
}

func TestAgentLehntGrundsaetzlichAb(t *testing.T) {
	hs := &fakeHosts{hs: []HostState{agentHost("a", "/"), agentHost("b", "/")}}
	cfg := DefaultConfig()
	d := New(testConfig(&cfg), hs)
	bus := newBus()
	d.Bus = bus
	d.CheckPath = func(h, p, k string) (bool, string) { return true, "" }
	bus.onExec = func(*fakeBus, string, agentRequest) agentResponse {
		return agentResponse{OK: false, Error: "Pfad \"/etc/x\" liegt außerhalb der erlaubten Wurzeln", Detail: "rejected"}
	}
	startLoop(t, d)
	r := d.Run(context.Background(), Spec{Tool: "ffmpeg", Target: "auto", Args: []string{"-i", "/etc/x"}})
	if r.Err == nil || !strings.Contains(r.Err.Error(), "abgelehnt") {
		t.Fatalf("%+v", r)
	}
	if bus.count("a:exec")+bus.count("b:exec") != 1 {
		t.Fatalf("keine Wiederholung bei grundsätzlicher Ablehnung: %v", bus.cmds)
	}
	if j := d.List(StateFailed); len(j) != 1 || j[0].Attempt != 1 {
		t.Fatalf("%+v", j)
	}
}

// Audit 2026-10-23 B3: lokal gab es keine Argumentprüfung.
func TestLokaleArgumentePruefung(t *testing.T) {
	root := t.TempDir()
	for _, c := range []struct {
		name  string
		args  []string
		roots []string
		bad   bool
	}{
		{"Elternpfad", []string{"-i", "../../etc/passwd", "o.mp4"}, nil, true},
		{"eingebettet", []string{"-vf", "movie=../x.mp4"}, nil, true},
		{"Nullzeichen", []string{"a\x00b"}, nil, true},
		{"ohne Wurzeln alles absolute erlaubt", []string{"-i", "/etc/hostname", "/tmp/o.mp4"}, nil, false},
		{"Wurzel: innen", []string{"-i", filepath.Join(root, "a.mxf"), filepath.Join(root, "neu", "o.mp4")}, []string{root}, false},
		{"Wurzel: außen", []string{"-i", "/etc/passwd"}, []string{root}, true},
		{"Wurzel: Filter außen", []string{"-vf", "movie=/etc/passwd[x]"}, []string{root}, true},
		{"Wurzel: file:-URL außen", []string{"-i", "file:///etc/passwd"}, []string{root}, true},
		{"Wurzel: Optionen und Ausdrücke bleiben", []string{"-vf", "scale=1280:720", "-c:v", "libx264"}, []string{root}, false},
	} {
		err := validateLocal(c.args, c.roots)
		var rej *rejectedError
		if c.bad && !errors.As(err, &rej) {
			t.Errorf("%s: Ablehnung erwartet, bekam %v", c.name, err)
		}
		if !c.bad && err != nil {
			t.Errorf("%s: erlaubt erwartet, bekam %v", c.name, err)
		}
	}
}

func TestLokalAbgelehnterJobScheitertSofortOhneWiederholung(t *testing.T) {
	hosts := &fakeHosts{hs: []HostState{localHost(5)}}
	cfg := DefaultConfig()
	cfg.MaxAttempts = 3
	d := New(testConfig(&cfg), hosts)
	d.LocalTool = script(t, `echo sollte-nie-laufen`)
	startLoop(t, d)
	res := d.Run(context.Background(), Spec{Tool: "ffmpeg", Args: []string{"-i", "../../etc/passwd", "o.mp4"}})
	if res.Err == nil || !strings.Contains(res.Err.Error(), "..") {
		t.Fatalf("%+v", res)
	}
	if j := d.List(StateFailed); len(j) != 1 || j[0].Attempt != 1 {
		t.Fatalf("keine Wiederholung erwartet: %+v", j)
	}
}

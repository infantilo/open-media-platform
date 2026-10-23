package jobrun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// HostSource liefert die Hostzustände (Telemetrie, Fähigkeiten, Live-Nodes) ohne Job-Zähler; der Dispatcher ergänzt
// seine eigenen Zähler und die Host-Optionen aus der Konfiguration.
type HostSource interface {
	Hosts() []HostState
}

// Bus ist der Weg zu den Host-Agents (NATS). nil: nur lokale Ausführung.
type Bus interface {
	Request(subject string, data []byte, timeout time.Duration) ([]byte, error)
	Subscribe(subject string, cb func(data []byte)) (unsubscribe func(), err error)
}

// Store persistiert Job-Datensätze (optional).
type Store interface {
	Save(j Job)
}

// Dispatcher nimmt Jobs an, wählt Hosts, überwacht und schützt die Sendung.
type Dispatcher struct {
	Config    func() Config
	Hosts     HostSource
	Bus       Bus
	Store     Store
	LocalTool func(tool string) string // Programmpfad auf dem Orchestrator-Rechner ("" = nicht vorhanden)
	// CheckPath prüft einen Pfad auf einem Agent-Host (kind: "file" | "dir").
	CheckPath func(hostID, path, kind string) (ok bool, why string)
	// Busy meldet gebuchte Live-Belegung eines Hosts innerhalb von within (nil = keine Buchungen bekannt).
	Busy func(hostID string, within time.Duration) (bool, string)
	// Demand liefert den gemessenen Live-Bedarf eines Hosts (hosts.History.LiveDemand) für die Auto-Kalibrierung; nil = keine.
	Demand func(hostID string, window time.Duration) (hosts.LiveDemand, bool)
	// Degraded meldet Aussetzer eines Live-Nodes auf dem Host (nil = nie).
	Degraded func(hostID string) bool

	mu       sync.Mutex
	jobs     map[string]*entry
	finished []string // IDs, älteste zuerst
	blocked  map[string]time.Time
	paths    map[string]pathCheck
	pathMu   sync.Mutex
	wake     chan struct{}
	lastSeen map[string]time.Time   // Host-ID → zuletzt online gesehen
	cal      map[string]Calibration // Host-ID → letzte (geglättete) Kalibrierung

	nPlaced, nRetry, nDone, nFailed, nCancelled atomic.Int64
	nProtect                                    [4]atomic.Int64 // throttle, pause, resume, cancel
	nWaitAlarm                                  atomic.Int64
}

type pathCheck struct {
	ok      bool
	pending bool
	why     string
	at      time.Time
}

type entry struct {
	job      Job
	done     chan struct{}
	res      Result
	spec     Spec
	cancel   func() // Backend: Prozess beenden
	pause    func(bool) error
	renice   func(int) error
	starting bool // zugewiesen, Backend noch nicht gestartet
	requeue  bool // Abbruch durch Sendeschutz: neu einplanen statt fehlschlagen
	requeues int
	userStop bool
	stdout   map[int][]byte
	tail     []string
	pausedAt time.Time
	waitFrom time.Time
	alarmed  bool
	parts    [][2]string // Teildateien des laufenden Versuchs
	gen      int         // Ausführungsnummer; veraltete Backend-Ereignisse werden ignoriert
}

const maxHistory = 200

// New legt einen Dispatcher an.
func New(cfg func() Config, hosts HostSource) *Dispatcher {
	return &Dispatcher{
		Config: cfg, Hosts: hosts,
		jobs: map[string]*entry{}, blocked: map[string]time.Time{}, paths: map[string]pathCheck{},
		wake: make(chan struct{}, 1), lastSeen: map[string]time.Time{}, cal: map[string]Calibration{},
	}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "j" + hex.EncodeToString(b)
}

func (d *Dispatcher) poke() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// Submit reiht einen Job ein und liefert seine ID.
func (d *Dispatcher) Submit(spec Spec) (string, error) {
	if spec.Tool != "ffmpeg" && spec.Tool != "ffprobe" {
		return "", fmt.Errorf("Programm %q nicht erlaubt (ffmpeg | ffprobe)", spec.Tool)
	}
	if !spec.Class.valid() {
		spec.Class = ClassBatch
	}
	if spec.Target != "" {
		if _, err := ParseTarget(spec.Target); err != nil {
			return "", err
		}
	}
	e := &entry{spec: spec, done: make(chan struct{}), stdout: map[int][]byte{}, waitFrom: time.Now()}
	e.job = Job{ID: newID(), Spec: spec, State: StateQueued, Created: time.Now()}
	d.mu.Lock()
	d.jobs[e.job.ID] = e
	d.mu.Unlock()
	d.save(e)
	d.poke()
	return e.job.ID, nil
}

// Wait blockiert bis zum Ende des Jobs; wird ctx vorher beendet, wird der Job abgebrochen.
func (d *Dispatcher) Wait(ctx context.Context, id string) Result {
	d.mu.Lock()
	e := d.jobs[id]
	d.mu.Unlock()
	if e == nil {
		return Result{Err: errors.New("Job unbekannt")}
	}
	select {
	case <-e.done:
	case <-ctx.Done():
		_ = d.Cancel(id)
		<-e.done
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return e.res
}

// Run reicht den Job ein und wartet auf das Ergebnis.
func (d *Dispatcher) Run(ctx context.Context, spec Spec) Result {
	id, err := d.Submit(spec)
	if err != nil {
		return Result{Err: err}
	}
	return d.Wait(ctx, id)
}

// Get liefert einen Job.
func (d *Dispatcher) Get(id string) (Job, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	e := d.jobs[id]
	if e == nil {
		return Job{}, false
	}
	return e.job, true
}

// List liefert Jobs (state "" = alle), neueste zuerst.
func (d *Dispatcher) List(state State) []Job {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Job, 0, len(d.jobs))
	for _, e := range d.jobs {
		if state == "" || e.job.State == state {
			out = append(out, e.job)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

// Cancel bricht einen Job ab (wartend: sofort; laufend: Prozess beenden).
func (d *Dispatcher) Cancel(id string) error {
	d.mu.Lock()
	e := d.jobs[id]
	if e == nil {
		d.mu.Unlock()
		return errors.New("Job unbekannt")
	}
	switch e.job.State {
	case StateDone, StateFailed, StateCancelled:
		d.mu.Unlock()
		return errors.New("Job ist bereits beendet")
	case StateQueued:
		d.finishLocked(e, Result{ExitCode: -1, Err: context.Canceled}, StateCancelled)
		d.mu.Unlock()
		d.save(e)
		return nil
	}
	e.userStop = true
	c := e.cancel
	d.mu.Unlock()
	if c != nil {
		c()
	}
	return nil
}

func (d *Dispatcher) logEvent(e *entry, kind, detail string) {
	e.job.Events = append(e.job.Events, JobEvent{At: time.Now(), Kind: kind, Detail: detail})
	if len(e.job.Events) > 40 {
		e.job.Events = e.job.Events[len(e.job.Events)-40:]
	}
}

func (d *Dispatcher) save(e *entry) {
	if d.Store == nil {
		return
	}
	d.mu.Lock()
	j := e.job
	d.mu.Unlock()
	d.Store.Save(j)
}

// finishLocked beendet einen Job endgültig (mu gehalten).
func (d *Dispatcher) finishLocked(e *entry, res Result, st State) {
	now := time.Now()
	e.job.State, e.job.Finished = st, &now
	e.job.ExitCode, e.job.Paused, e.job.Wait = res.ExitCode, false, ""
	if res.Err != nil {
		e.job.Error = res.Err.Error()
	}
	res.Host = e.job.Host
	e.res = res
	e.cancel, e.pause, e.renice = nil, nil, nil
	switch st {
	case StateDone:
		d.nDone.Add(1)
	case StateCancelled:
		d.nCancelled.Add(1)
	default:
		d.nFailed.Add(1)
	}
	select {
	case <-e.done:
	default:
		close(e.done)
	}
	d.finished = append(d.finished, e.job.ID)
	for len(d.finished) > maxHistory {
		delete(d.jobs, d.finished[0])
		d.finished = d.finished[1:]
	}
	d.poke()
}

// Run (Schleife): Zuweisung, Wächter, Hostverlust. Blockiert bis ctx endet.
func (d *Dispatcher) Loop(ctx context.Context) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	var lastProtect, lastHousekeep, lastCalib time.Time
	for {
		select {
		case <-ctx.Done():
			d.shutdown()
			return
		case <-t.C:
		case <-d.wake:
		}
		now := time.Now()
		cfg := d.Config()
		if now.Sub(lastHousekeep) >= 2*time.Second {
			lastHousekeep = now
			d.checkHostLoss(cfg)
		}
		if now.Sub(lastCalib) >= 5*time.Minute {
			lastCalib = now
			d.refreshCalibration(cfg)
		}
		if now.Sub(lastProtect) >= time.Duration(cfg.Protect.IntervalS)*time.Second {
			lastProtect = now
			d.protect(cfg)
		}
		d.schedule(cfg)
	}
}

// shutdown: Führung verloren/Beenden — laufende Jobs abbrechen (der neue Leader startet nichts davon neu; die
// Aufrufer erhalten einen Ausführungsfehler und wiederholen über ihre eigene Logik).
func (d *Dispatcher) shutdown() {
	d.mu.Lock()
	var cancels []func()
	for _, e := range d.jobs {
		switch e.job.State {
		case StateRunning:
			e.userStop = true
			if e.cancel != nil {
				cancels = append(cancels, e.cancel)
			}
		case StateQueued:
			d.finishLocked(e, Result{ExitCode: -1, Err: errors.New("Orchestrator beendet")}, StateFailed)
		}
	}
	d.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// states baut die Hostzustände mit Zählern und Optionen (mu gehalten).
func (d *Dispatcher) statesLocked(cfg Config) []HostState {
	src := d.Hosts.Hosts()
	out := make([]HostState, 0, len(src))
	for _, h := range src {
		o := cfg.hostOpts(h.ID)
		h.Disabled = !o.enabled()
		h.BatchOnly, h.NoBatch, h.Pools = o.BatchOnly, o.NoBatch, o.Pools
		if o.MaxJobs > 0 {
			h.MaxJobs = o.MaxJobs
		}
		rs, _ := d.reserveLocked(h.ID, cfg)
		h.Reserve = &rs
		if h.CPUCores <= 0 {
			h.CPUCores = 4
		}
		h.ByClass = map[Class]int{}
		h.Jobs = nil
		for _, e := range d.jobs {
			if e.job.State != StateRunning || e.job.Host != h.ID {
				continue
			}
			if e.starting {
				h.Reserved++
				h.ReservedCPU += 100 / h.CPUCores
				continue
			}
			h.Running++
			h.ByClass[e.spec.Class]++
			h.Jobs = append(h.Jobs, RunningJob{ID: e.job.ID, Class: e.spec.Class, Paused: e.job.Paused, PausedSince: e.pausedAt,
				Nice: e.job.Nice, Started: derefTime(e.job.Started), Pausable: !e.spec.LiveInput && e.pause != nil})
		}
		if until, ok := d.blocked[h.ID]; ok && time.Now().Before(until) {
			h.Online = false
		}
		out = append(out, h)
	}
	return out
}

func derefTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}

func (d *Dispatcher) schedule(cfg Config) {
	d.mu.Lock()
	var queued []*entry
	for _, e := range d.jobs {
		if e.job.State == StateQueued {
			queued = append(queued, e)
		}
	}
	if len(queued) == 0 {
		d.mu.Unlock()
		return
	}
	sort.Slice(queued, func(i, j int) bool {
		a, b := queued[i], queued[j]
		if a.spec.Class.rank() != b.spec.Class.rank() {
			return a.spec.Class.rank() < b.spec.Class.rank()
		}
		return a.job.Created.Before(b.job.Created)
	})
	states := d.statesLocked(cfg)
	type start struct {
		e    *entry
		host HostState
		gen  int
	}
	var starts []start
	var persist []*entry
	now := time.Now()
	for _, e := range queued {
		tgt, err := cfg.TargetFor(e.spec)
		if err != nil {
			d.finishLocked(e, Result{ExitCode: -1, Err: err}, StateFailed)
			persist = append(persist, e)
			continue
		}
		cands := filterExcluded(states, e.job.Exclude)
		dec := d.place(e, tgt, cands, cfg)
		if dec.Host == "" && cfg.FallbackLocal && tgt.Kind != "local" && waited(e, now) >= time.Duration(cfg.MaxWaitS)*time.Second/4 {
			if fb := d.place(e, Target{Kind: "local"}, cands, cfg); fb.Host != "" {
				fb.Reason = "Ausweichen auf den Orchestrator-Rechner: " + dec.Reason
				dec = fb
			}
		}
		e.job.Placement = &dec
		if dec.Host == "" {
			if e.job.Wait != dec.Reason {
				e.job.Wait = dec.Reason
				d.logEvent(e, "wait", dec.Reason)
			}
			if !e.alarmed && waited(e, now) > time.Duration(cfg.MaxWaitS)*time.Second {
				e.alarmed = true
				d.nWaitAlarm.Add(1)
				slog.Warn("jobrun: job wartet länger als maxWaitS", "job", e.job.ID, "caller", e.spec.Caller, "reason", dec.Reason)
			}
			continue
		}
		// Reservieren: Zähler sofort erhöhen, damit der nächste Job im selben Durchlauf einen anderen Host sieht.
		for i := range states {
			if states[i].ID == dec.Host {
				states[i].Reserved++
				states[i].ReservedCPU += 100 / states[i].CPUCores
				var hs HostState = states[i]
				e.job.State, e.job.Host, e.job.Wait, e.starting = StateRunning, dec.Host, "", true
				e.job.Attempt++
				e.gen++
				t := now
				e.job.Started = &t
				e.job.Nice, e.job.Paused = 0, false
				d.logEvent(e, "placed", fmt.Sprintf("%s (Versuch %d)", dec.Host, e.job.Attempt))
				starts = append(starts, start{e: e, host: hs, gen: e.gen})
				persist = append(persist, e)
				d.nPlaced.Add(1)
				break
			}
		}
	}
	d.mu.Unlock()
	for _, e := range persist {
		d.save(e)
	}
	for _, s := range starts {
		go d.launch(s.e, s.host, s.gen, cfg)
	}
}

func waited(e *entry, now time.Time) time.Duration { return now.Sub(e.waitFrom) }

func filterExcluded(states []HostState, exclude []string) []HostState {
	if len(exclude) == 0 {
		return states
	}
	out := make([]HostState, 0, len(states))
	for _, h := range states {
		if !has(exclude, h.ID) {
			out = append(out, h)
		}
	}
	return out
}

func (d *Dispatcher) place(e *entry, tgt Target, states []HostState, cfg Config) Decision {
	pc := PlaceCtx{Now: time.Now()}
	pc.PathOK = func(h HostState) (bool, string) { return d.pathsVisible(h, e.spec, cfg) }
	if d.Busy != nil {
		pc.Busy = func(h HostState, within time.Duration) (bool, string) { return d.Busy(h.ID, within) }
	}
	return Place(e.spec, tgt, states, cfg, pc)
}

// launch startet den Job im Backend; mu NICHT gehalten.
func (d *Dispatcher) launch(e *entry, h HostState, gen int, cfg Config) {
	args := append([]string(nil), e.spec.Args...)
	var parts [][2]string // [Teilpfad, Zielpfad] (Orchestrator-Sicht)
	if e.spec.Atomic {
		for _, o := range e.spec.Outputs {
			p := partName(o, e.job.Attempt)
			for i, a := range args {
				if a == o {
					args[i] = p
				}
			}
			parts = append(parts, [2]string{p, o})
		}
	}
	d.mu.Lock()
	e.parts = parts
	d.mu.Unlock()
	var err error
	if h.Local {
		err = d.startLocal(e, gen, args, parts, cfg)
	} else {
		err = d.startAgent(e, h, gen, args, parts, cfg)
	}
	if err != nil {
		d.executionFailed(e, gen, h.ID, err, cfg)
	}
}

// partName: Teildatei je Versuch — läuft nach einem Hostausfall noch ein verwaister Prozess des vorigen Versuchs, schreibt er in
// eine andere Datei als der neue Versuch.
func partName(out string, attempt int) string {
	ext := filepath.Ext(out)
	return fmt.Sprintf("%s.part%d%s", strings.TrimSuffix(out, ext), attempt, ext)
}

// executionFailed: der Job konnte nicht (zu Ende) ausgeführt werden → anderer Host oder Fehlschlag.
func (d *Dispatcher) executionFailed(e *entry, gen int, host string, err error, cfg Config) {
	d.mu.Lock()
	if e.gen != gen || e.job.State != StateRunning {
		d.mu.Unlock()
		return
	}
	var rej *rejectedError
	isRej := errors.As(err, &rej)
	if host != LocalHostID && host != "" && !e.userStop && !isRej {
		d.blocked[host] = time.Now().Add(60 * time.Second)
	}
	e.starting, e.cancel, e.pause, e.renice = false, nil, nil, nil
	for _, p := range e.parts { // Teildateien des gescheiterten Versuchs entfernen
		_ = os.Remove(p[0])
	}
	if e.userStop {
		d.finishLocked(e, Result{ExitCode: -1, Err: context.Canceled}, StateCancelled)
	} else if errors.Is(err, errTimeout) || isRej {
		d.finishLocked(e, Result{ExitCode: -1, Err: err}, StateFailed)
	} else if e.job.Attempt < cfg.MaxAttempts {
		e.job.State, e.job.Started, e.job.Paused = StateQueued, nil, false
		e.job.Exclude = append(e.job.Exclude, host)
		e.job.Wait = "Ausführung auf " + host + " fehlgeschlagen: " + err.Error()
		e.waitFrom = time.Now()
		d.logEvent(e, "retry", host+": "+err.Error())
		d.nRetry.Add(1)
	} else {
		d.finishLocked(e, Result{ExitCode: -1, Err: fmt.Errorf("%s: %w", host, err)}, StateFailed)
	}
	d.mu.Unlock()
	d.save(e)
	d.poke()
}

// completed wertet das Ende eines Backend-Laufs aus (ExitCode ist ein Ergebnis; execErr ein Ausführungsfehler).
func (d *Dispatcher) completed(e *entry, gen int, host string, exit int, stdout []byte, tail []string, execErr error, parts [][2]string, cfg Config) {
	d.mu.Lock()
	if e.gen != gen || e.job.State != StateRunning {
		d.mu.Unlock()
		return
	}
	requeue, userStop := e.requeue, e.userStop
	e.requeue = false
	d.mu.Unlock()
	if execErr == nil && exit == 0 {
		for _, p := range parts {
			if err := os.Rename(p[0], p[1]); err != nil {
				execErr = fmt.Errorf("Ergebnis nicht ablegbar: %w", err)
				break
			}
		}
	}
	if execErr != nil || exit != 0 {
		for _, p := range parts {
			_ = os.Remove(p[0])
		}
	}
	if requeue && !userStop {
		d.mu.Lock()
		e.requeues++
		if e.requeues > 5 {
			d.finishLocked(e, Result{ExitCode: -1, Err: errors.New("durch den Sendeschutz mehrfach abgebrochen")}, StateFailed)
		} else {
			e.starting, e.cancel, e.pause, e.renice = false, nil, nil, nil
			e.job.State, e.job.Started, e.job.Paused = StateQueued, nil, false
			e.job.Wait = "durch den Sendeschutz abgebrochen, wird neu eingeplant"
			e.waitFrom = time.Now()
		}
		d.mu.Unlock()
		d.save(e)
		d.poke()
		return
	}
	if execErr != nil {
		d.executionFailed(e, gen, host, execErr, cfg)
		return
	}
	d.mu.Lock()
	d.finishLocked(e, Result{ExitCode: exit, Stdout: stdout, Tail: tail}, StateDone)
	d.mu.Unlock()
	d.save(e)
}

func (d *Dispatcher) setProgress(e *entry, gen int, line string) {
	d.mu.Lock()
	if e.gen == gen {
		e.job.Progress = line
	}
	d.mu.Unlock()
}

func (d *Dispatcher) markStarted(e *entry, gen int, cancel func(), pause func(bool) error, renice func(int) error) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if e.gen != gen || e.job.State != StateRunning {
		return false
	}
	e.starting = false
	e.cancel, e.pause, e.renice = cancel, pause, renice
	return true
}

// checkHostLoss: läuft ein Job auf einem Host, der nicht mehr online ist, wird er auf einem anderen neu eingeplant.
func (d *Dispatcher) checkHostLoss(cfg Config) {
	d.mu.Lock()
	online := map[string]bool{}
	for _, h := range d.Hosts.Hosts() {
		online[h.ID] = h.Online
		if h.Online {
			d.lastSeen[h.ID] = time.Now()
		}
	}
	var lost []*entry
	for _, e := range d.jobs {
		if e.job.State != StateRunning || e.job.Host == LocalHostID {
			continue
		}
		if !online[e.job.Host] && time.Since(d.lastSeen[e.job.Host]) > 15*time.Second {
			lost = append(lost, e)
		}
	}
	gens := make([]int, len(lost))
	for i, e := range lost {
		gens[i] = e.gen
	}
	d.mu.Unlock()
	for i, e := range lost {
		host := e.job.Host
		slog.Warn("jobrun: Host fiel während eines Jobs aus", "host", host, "job", e.job.ID)
		d.executionFailed(e, gens[i], host, errors.New("Host nicht mehr erreichbar"), cfg)
	}
}

// protect: Sendeschutz-Wächter.
func (d *Dispatcher) protect(cfg Config) {
	if !cfg.Protect.Enabled {
		return
	}
	d.mu.Lock()
	states := d.statesLocked(cfg)
	d.mu.Unlock()
	for _, h := range states {
		if len(h.Jobs) == 0 {
			continue
		}
		deg := d.Degraded != nil && d.Degraded(h.ID)
		for _, a := range Evaluate(ProtectInput{Host: h, Degraded: deg, Now: time.Now()}, cfg) {
			d.apply(a, h.ID)
		}
	}
}

func (d *Dispatcher) apply(a Action, host string) {
	d.mu.Lock()
	e := d.jobs[a.JobID]
	if e == nil || e.job.State != StateRunning || e.starting {
		d.mu.Unlock()
		return
	}
	cancel, pause, renice := e.cancel, e.pause, e.renice
	d.mu.Unlock()
	var err error
	switch a.Kind {
	case ActThrottle:
		if renice != nil {
			err = renice(a.Nice)
		}
		if err == nil {
			d.mu.Lock()
			e.job.Nice = a.Nice
			d.mu.Unlock()
		}
		d.nProtect[0].Add(1)
	case ActPause, ActResume:
		if pause != nil {
			err = pause(a.Kind == ActPause)
		}
		if err == nil {
			d.mu.Lock()
			e.job.Paused = a.Kind == ActPause
			if e.job.Paused {
				e.pausedAt = time.Now()
			} else {
				e.pausedAt = time.Time{}
			}
			d.mu.Unlock()
		}
		if a.Kind == ActPause {
			d.nProtect[1].Add(1)
		} else {
			d.nProtect[2].Add(1)
		}
	case ActCancel:
		d.mu.Lock()
		e.requeue = true
		d.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		d.nProtect[3].Add(1)
	}
	d.mu.Lock()
	kind := string(a.Kind)
	detail := a.Reason
	if err != nil {
		detail += " (fehlgeschlagen: " + err.Error() + ")"
	}
	d.logEvent(e, kind, detail)
	d.mu.Unlock()
	slog.Warn("jobrun: Sendeschutz greift ein", "host", host, "job", a.JobID, "action", a.Kind, "reason", a.Reason, "err", err)
	d.save(e)
}

// --- Pfade ---------------------------------------------------------------------------------------------

// MapPath schreibt einen Orchestrator-Pfad für einen Host um (längster Präfix gewinnt); ok=false: keine Zuordnung nötig/möglich.
func MapPath(cfg Config, hostID, p string) (string, bool) {
	best := ""
	for prefix := range cfg.PathMap {
		if (p == prefix || strings.HasPrefix(p, strings.TrimSuffix(prefix, "/")+"/")) && len(prefix) > len(best) {
			if _, ok := cfg.PathMap[prefix][hostID]; ok {
				best = prefix
			}
		}
	}
	if best == "" {
		return p, false
	}
	return strings.TrimSuffix(cfg.PathMap[best][hostID], "/") + strings.TrimPrefix(p, strings.TrimSuffix(best, "/")), true
}

func mapArgs(cfg Config, hostID string, args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i], _ = MapPath(cfg, hostID, a)
	}
	return out
}

func (d *Dispatcher) pathsVisible(h HostState, s Spec, cfg Config) (bool, string) {
	check := func(p, kind string) (bool, string) {
		if h.Local {
			st, err := os.Stat(p)
			if err != nil {
				return false, err.Error()
			}
			if kind == "dir" && !st.IsDir() {
				return false, p + " ist kein Verzeichnis"
			}
			return true, ""
		}
		mapped, _ := MapPath(cfg, h.ID, p)
		if mapped == p {
			if _, has := cfg.pathMapHost(h.ID); !has && !underAny(p, h.Roots) {
				return false, "kein Pfad für Host " + h.ID + " (pathMap)"
			}
		}
		if !underAny(mapped, h.Roots) {
			return false, mapped + " liegt außerhalb der jobRoots des Hosts"
		}
		key := h.ID + "|" + kind + "|" + mapped
		d.pathMu.Lock()
		c, ok := d.paths[key]
		d.pathMu.Unlock()
		ttl := 30 * time.Second
		if ok && !c.ok && !c.pending {
			ttl = 10 * time.Second // Fehlschläge bald erneut prüfen
		}
		if ok && (c.pending || time.Since(c.at) < ttl) {
			if c.pending {
				return false, "Pfadprüfung läuft"
			}
			return c.ok, c.why
		}
		if d.CheckPath == nil {
			return true, ""
		}
		// Netzwerkaufruf nie unter der Dispatcher-Sperre: im Hintergrund prüfen, bis dahin „läuft“.
		d.pathMu.Lock()
		d.paths[key] = pathCheck{pending: true, at: time.Now()}
		d.pathMu.Unlock()
		go func() {
			okp, why := d.CheckPath(h.ID, mapped, kind)
			d.pathMu.Lock()
			d.paths[key] = pathCheck{ok: okp, why: why, at: time.Now()}
			d.pathMu.Unlock()
			d.poke()
		}()
		return false, "Pfadprüfung läuft"
	}
	for _, in := range s.Inputs {
		if ok, why := check(in, "file"); !ok {
			return false, why
		}
	}
	for _, out := range s.Outputs {
		if ok, why := check(filepath.Dir(out), "dir"); !ok {
			return false, why
		}
	}
	return true, ""
}

func (c Config) pathMapHost(hostID string) (string, bool) {
	for _, m := range c.PathMap {
		if v, ok := m[hostID]; ok {
			return v, true
		}
	}
	return "", false
}

func underAny(p string, roots []string) bool {
	p = filepath.Clean(p)
	for _, r := range roots {
		r = filepath.Clean(r)
		if p == r || strings.HasPrefix(p, r+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// limitBuffer begrenzt gesammelte Ausgabe.
type limitBuffer struct {
	b   []byte
	max int
}

func (l *limitBuffer) Write(p []byte) (int, error) {
	if room := l.max - len(l.b); room > 0 {
		if len(p) > room {
			l.b = append(l.b, p[:room]...)
		} else {
			l.b = append(l.b, p...)
		}
	}
	return len(p), nil
}

var _ io.Writer = (*limitBuffer)(nil)

// --- Metriken ------------------------------------------------------------------------------------------

// Counts liefert Zähler für Metriken und Anzeige.
func (d *Dispatcher) Counts() (running, waiting int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, e := range d.jobs {
		switch e.job.State {
		case StateRunning:
			running++
		case StateQueued:
			waiting++
		}
	}
	return
}

// WriteMetrics schreibt Prometheus-Zeilen.
func (d *Dispatcher) WriteMetrics(w io.Writer) {
	run, wait := d.Counts()
	fmt.Fprintf(w, "# TYPE omp_jobs_running gauge\nomp_jobs_running %d\n# TYPE omp_jobs_waiting gauge\nomp_jobs_waiting %d\n", run, wait)
	fmt.Fprintf(w, "# TYPE omp_jobs_total counter\nomp_jobs_total{result=\"done\"} %d\nomp_jobs_total{result=\"failed\"} %d\nomp_jobs_total{result=\"cancelled\"} %d\n", d.nDone.Load(), d.nFailed.Load(), d.nCancelled.Load())
	fmt.Fprintf(w, "# TYPE omp_job_placement_total counter\nomp_job_placement_total{reason=\"placed\"} %d\nomp_job_placement_total{reason=\"retry\"} %d\nomp_job_placement_total{reason=\"wait_alarm\"} %d\n", d.nPlaced.Load(), d.nRetry.Load(), d.nWaitAlarm.Load())
	fmt.Fprintf(w, "# TYPE omp_job_protect_total counter\n")
	for i, n := range []string{"throttle", "pause", "resume", "cancel"} {
		fmt.Fprintf(w, "omp_job_protect_total{action=%q} %d\n", n, d.nProtect[i].Load())
	}
}

// Preload übernimmt beendete Jobs einer früheren Laufzeit als Verlauf (nur Anzeige).
func (d *Dispatcher) Preload(jobs []Job) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, j := range jobs {
		if _, dup := d.jobs[j.ID]; dup {
			continue
		}
		e := &entry{job: j, spec: j.Spec, done: make(chan struct{})}
		close(e.done)
		d.jobs[j.ID] = e
		d.finished = append(d.finished, j.ID)
	}
	for len(d.finished) > maxHistory {
		delete(d.jobs, d.finished[0])
		d.finished = d.finished[1:]
	}
}

// HostStates liefert die aktuellen Hostzustände samt Zählern (Anzeige „Hosts“).
func (d *Dispatcher) HostStates() []HostState {
	cfg := d.Config()
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.statesLocked(cfg)
}

// Preview wählt probeweise einen Host für einen Job, ohne ihn zu starten („warum dort?“).
func (d *Dispatcher) Preview(spec Spec) (Decision, error) {
	cfg := d.Config()
	tgt, err := cfg.TargetFor(spec)
	if err != nil {
		return Decision{}, err
	}
	if !spec.Class.valid() {
		spec.Class = ClassBatch
	}
	e := &entry{spec: spec}
	d.mu.Lock()
	states := d.statesLocked(cfg)
	d.mu.Unlock()
	return d.place(e, tgt, states, cfg), nil
}

// reserveLocked liefert die für den Host geltende Reserve und deren Herkunft (mu gehalten).
func (d *Dispatcher) reserveLocked(hostID string, cfg Config) (Reserve, string) {
	if r := cfg.hostOpts(hostID).Reserve; r != nil {
		return *r, "host"
	}
	if cfg.Calibration.Mode == "auto" {
		if c, ok := d.cal[hostID]; ok && c.Enough {
			return c.Applied, "auto"
		}
	}
	return cfg.Reserve, "config"
}

// refreshCalibration berechnet den Live-Bedarf aller Hosts neu und glättet die Anwendung (Anstieg sofort, Rückgang langsam).
func (d *Dispatcher) refreshCalibration(cfg Config) {
	if d.Demand == nil || d.Hosts == nil {
		return
	}
	src := d.Hosts.Hosts()
	window := time.Duration(cfg.Calibration.WindowDays) * 24 * time.Hour
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, h := range src {
		dem, ok := d.Demand(h.ID, window)
		c := Calibrate(dem, ok, h.CPUCores, h.Gpu != nil, cfg.Reserve, cfg.Calibration)
		c.Host, c.Label = h.ID, h.Label
		if c.Enough {
			if prev, had := d.cal[h.ID]; had && prev.Enough {
				c.Applied = smooth(prev.Applied, c.Suggested, 0.01)
			} else {
				c.Applied = c.Suggested
			}
		} else {
			c.Applied = cfg.Reserve
		}
		d.cal[h.ID] = c
	}
}

// Calibrations liefert je Host den gemessenen Bedarf, den Vorschlag und die tatsächlich geltende Reserve samt Herkunft.
func (d *Dispatcher) Calibrations() []Calibration {
	cfg := d.Config()
	d.refreshCalibration(cfg)
	src := d.Hosts.Hosts()
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Calibration, 0, len(src))
	for _, h := range src {
		c := d.cal[h.ID]
		if c.Host == "" {
			c.Host, c.Label, c.Reason = h.ID, h.Label, "no-data"
			c.Suggested = cfg.Reserve
		}
		c.Applied, c.Source = d.reserveLocked(h.ID, cfg)
		out = append(out, c)
	}
	return out
}

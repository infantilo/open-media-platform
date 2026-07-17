package launcher

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// recordingPublisher sammelt Broadcast()-Aufrufe statt sie an echte SSE-
// Clients zu senden — Stand-in für den *sse.Hub in Tests.
type recordingPublisher struct {
	mu     sync.Mutex
	events []sse.Event
}

func (p *recordingPublisher) Broadcast(e sse.Event) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, e)
}

func (p *recordingPublisher) snapshot() []sse.Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]sse.Event{}, p.events...)
}

// sleepyCatalog startet einen echten, kurzlebigen Subprozess, der lang
// genug lebt, um in Tests beobachtet zu werden — os/exec lässt sich
// nicht sinnvoll ohne echten Subprozess testen (kein Interface-Seam im
// Standardpaket). `sleep` direkt (kein Shell-Wrapper): terminiert per
// Default-Disposition sofort auf SIGTERM, kein Risiko verwaister
// Hintergrund-Kindprozesse wie bei einem "cmd & wait"-Shell-Muster.
func sleepyCatalog() []CatalogEntry {
	return []CatalogEntry{{
		Type:    "sleepy",
		Label:   "Sleepy",
		Runner:  "process",
		Command: []string{"sleep", "30"},
		Env:     map[string]string{},
	}}
}

// stubbornCatalog ignoriert SIGTERM, damit der SIGKILL-Fallback in
// Stop() getestet werden kann. `trap '' TERM` setzt die Disposition auf
// SIG_IGN, die laut POSIX über `exec` hinweg erhalten bleibt — `exec
// sleep 30` ersetzt den Shell-Prozess durch `sleep` selbst (gleiche PID,
// kein separater Hintergrund-Kindprozess).
func stubbornCatalog() []CatalogEntry {
	return []CatalogEntry{{
		Type:    "stubborn",
		Label:   "Stubborn",
		Runner:  "process",
		Command: []string{"/bin/sh", "-c", "trap '' TERM; exec sleep 30"},
		Env:     map[string]string{},
	}}
}

// disableAutoRestart schaltet K7-Teil-1s automatischen Neustart für die
// Dauer eines Tests ab (maxCrashRestarts=0 löst die Crash-Loop-Bremse
// bereits beim ersten unerwarteten Ende aus) — für Tests, die einen
// Subprozess bewusst enden lassen und das bisherige "bleibt einfach
// crashed"-Verhalten prüfen wollen, ohne dass im Hintergrund eine
// Neustart-Goroutine über den Testlauf hinaus weiterläuft.
func disableAutoRestart(t *testing.T) {
	t.Helper()
	originalMax := maxCrashRestarts
	maxCrashRestarts = 0
	t.Cleanup(func() { maxCrashRestarts = originalMax })
}

func TestLauncherStartUnknownTypeReturnsError(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, nil)

	if _, err := l.Start("does-not-exist", "", nil); err != ErrUnknownType {
		t.Fatalf("Start() error = %v, want ErrUnknownType", err)
	}
}

func TestLauncherStartUnsupportedRunnerReturnsError(t *testing.T) {
	catalog := []CatalogEntry{{Type: "x", Label: "X", Runner: "podman", Command: []string{"true"}}}
	l := New(catalog, "http://registry", "nats://nats", t.TempDir(), nil, nil)

	if _, err := l.Start("x", "", nil); err != ErrUnsupportedRunner {
		t.Fatalf("Start() error = %v, want ErrUnsupportedRunner", err)
	}
}

func TestLauncherStartAppearsInListAndStopRemovesIt(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, nil)

	inst, err := l.Start("sleepy", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if inst.Type != "sleepy" || inst.PID <= 0 {
		t.Fatalf("Start() = %+v, want valid type/pid", inst)
	}
	if !processAlive(inst.PID) {
		t.Fatal("started process is not alive")
	}

	list := l.List()
	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry with id %s", list, inst.ID)
	}

	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if processAlive(inst.PID) {
		t.Error("process still alive after Stop()")
	}
	if len(l.List()) != 0 {
		t.Errorf("List() after Stop() = %+v, want empty", l.List())
	}
}

func TestLauncherStopSendsSigkillIfSigtermIgnored(t *testing.T) {
	original := stopGracePeriod
	stopGracePeriod = 500 * time.Millisecond
	defer func() { stopGracePeriod = original }()

	l := New(stubbornCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, nil)
	inst, err := l.Start("stubborn", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if processAlive(inst.PID) {
		t.Error("process still alive after Stop() should have escalated to SIGKILL")
	}
}

func TestLauncherStopUnknownInstanceReturnsError(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, nil)
	if err := l.Stop("does-not-exist"); err != ErrUnknownInstance {
		t.Fatalf("Stop() error = %v, want ErrUnknownInstance", err)
	}
}

func TestLauncherReloadsStillRunningInstanceAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	l1 := New(sleepyCatalog(), "http://registry", "nats://nats", dataDir, nil, nil)
	inst, err := l1.Start("sleepy", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() { _ = l1.Stop(inst.ID) }()

	l2 := New(sleepyCatalog(), "http://registry", "nats://nats", dataDir, nil, nil)
	list := l2.List()
	if len(list) != 1 || list[0].ID != inst.ID || list[0].PID != inst.PID {
		t.Fatalf("List() after restart = %+v, want the still-running instance %+v", list, inst)
	}
}

func TestLauncherDropsDeadInstanceAfterRestart(t *testing.T) {
	disableAutoRestart(t)
	dataDir := t.TempDir()
	quickExit := []CatalogEntry{{Type: "quick", Label: "Quick", Runner: "process", Command: []string{"/bin/sh", "-c", "exit 0"}}}

	l1 := New(quickExit, "http://registry", "nats://nats", dataDir, nil, nil)
	inst, err := l1.Start("quick", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for processAlive(inst.PID) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(inst.PID) {
		t.Fatal("quick-exit process did not terminate in time")
	}

	l2 := New(quickExit, "http://registry", "nats://nats", dataDir, nil, nil)
	if list := l2.List(); len(list) != 0 {
		t.Errorf("List() after restart = %+v, want empty (dead instance dropped)", list)
	}
}

func TestLauncherStartSetsRequiredEnvVars(t *testing.T) {
	disableAutoRestart(t)
	envFile := t.TempDir() + "/env.txt"
	catalog := []CatalogEntry{{
		Type:   "envdump",
		Label:  "EnvDump",
		Runner: "process",
		Command: []string{
			"/bin/sh", "-c",
			"env > " + envFile,
		},
		Env: map[string]string{"OMP_CUSTOM": "from-catalog"},
	}}
	l := New(catalog, "http://registry:8010", "nats://nats:4222", t.TempDir(), nil, nil)

	inst, err := l.Start("envdump", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	var data []byte
	for time.Now().Before(deadline) {
		data, err = os.ReadFile(envFile)
		if err == nil && len(data) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("read env dump: %v", err)
	}

	env := string(data)
	checks := map[string]string{
		"OMP_INSTANCE_ID":  inst.ID,
		"OMP_LABEL":        inst.Label,
		"OMP_PORT":         "0",
		"OMP_REGISTRY_URL": "http://registry:8010",
		"OMP_NATS_URL":     "nats://nats:4222",
		"OMP_CUSTOM":       "from-catalog",
	}
	for key, want := range checks {
		if !strings.Contains(env, key+"="+want) {
			t.Errorf("subprocess env missing %s=%s;\nfull env:\n%s", key, want, env)
		}
	}
}

// TestLauncherStartExtraEnvOverridesCatalogButNotReservedVars ist die
// Kern-Verifikation für Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c,
// 2026-07-17): Start()s extraEnv-Parameter (z. B. eine Workflow-
// Auflösungs-Einstellung) muss den Katalog-eigenen env-Block
// überschreiben können, darf aber niemals gegen die fünf vom Launcher
// selbst gesetzten OMP_*-Variablen gewinnen.
func TestLauncherStartExtraEnvOverridesCatalogButNotReservedVars(t *testing.T) {
	disableAutoRestart(t)
	envFile := t.TempDir() + "/env.txt"
	catalog := []CatalogEntry{{
		Type:   "envdump2",
		Label:  "EnvDump2",
		Runner: "process",
		Command: []string{
			"/bin/sh", "-c",
			"env > " + envFile,
		},
		Env: map[string]string{"OMP_CUSTOM": "from-catalog", "OMP_WIDTH": "640"},
	}}
	l := New(catalog, "http://registry:8010", "nats://nats:4222", t.TempDir(), nil, nil)

	inst, err := l.Start("envdump2", "", map[string]string{
		"OMP_WIDTH":       "1280",   // überschreibt den Katalog-Wert
		"OMP_INSTANCE_ID": "hacked", // darf NICHT gegen die reservierte Variable gewinnen
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	var data []byte
	for time.Now().Before(deadline) {
		data, err = os.ReadFile(envFile)
		if err == nil && len(data) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("read env dump: %v", err)
	}

	env := string(data)
	if !strings.Contains(env, "OMP_WIDTH=1280") {
		t.Errorf("extraEnv did not override catalog env; full env:\n%s", env)
	}
	if !strings.Contains(env, "OMP_INSTANCE_ID="+inst.ID) {
		t.Errorf("extraEnv illegally overrode the reserved OMP_INSTANCE_ID; full env:\n%s", env)
	}
	if strings.Contains(env, "OMP_INSTANCE_ID=hacked") {
		t.Errorf("extraEnv illegally overrode the reserved OMP_INSTANCE_ID; full env:\n%s", env)
	}
}

func TestLauncherMarksUnexpectedExitAsCrashedAndBroadcasts(t *testing.T) {
	disableAutoRestart(t)
	crashing := []CatalogEntry{{
		Type:    "crashy",
		Label:   "Crashy",
		Runner:  "process",
		Command: []string{"/bin/sh", "-c", "echo boom >&2; exit 1"},
	}}
	pub := &recordingPublisher{}
	l := New(crashing, "http://registry", "nats://nats", t.TempDir(), pub, nil)

	inst, err := l.Start("crashy", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	var list []Instance
	for time.Now().Before(deadline) {
		list = l.List()
		if len(list) == 1 && list[0].Crashed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry for %s", list, inst.ID)
	}
	if !list[0].Crashed {
		t.Fatalf("List()[0].Crashed = false, want true")
	}
	if !strings.Contains(list[0].CrashMessage, "boom") {
		t.Errorf("CrashMessage = %q, want it to contain stderr tail %q", list[0].CrashMessage, "boom")
	}

	events := pub.snapshot()
	if len(events) != 1 || events[0].Type != "instance.crashed" {
		t.Fatalf("Broadcast events = %+v, want one instance.crashed event", events)
	}
	if !strings.Contains(string(events[0].Data), inst.ID) {
		t.Errorf("event data = %s, want it to contain instance id %s", events[0].Data, inst.ID)
	}

	// Aufräumen ohne processAlive-Race: eine bereits tote Instanz per
	// Stop() zu entfernen muss trotzdem funktionieren (kein Fehler nötig).
	_ = l.Stop(inst.ID)
}

// recordingRestartObserver zeichnet InstanceRestarted()-Aufrufe auf —
// Stand-in für *workflows.Service in Tests.
type recordingRestartObserver struct {
	mu  sync.Mutex
	ids []string
}

func (o *recordingRestartObserver) InstanceRestarted(id string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ids = append(o.ids, id)
}

func (o *recordingRestartObserver) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string{}, o.ids...)
}

// shortCrashRestartTiming setzt Backoff/Fenster auf testtaugliche Werte
// (Sekunden statt der Produktions-Voreinstellung 2s/60s) und stellt sie
// nach dem Test wieder her — gleiches Muster wie stopGracePeriod.
func shortCrashRestartTiming(t *testing.T, backoff, window time.Duration) {
	t.Helper()
	origBackoff, origWindow := crashRestartBackoff, crashRestartWindow
	crashRestartBackoff, crashRestartWindow = backoff, window
	t.Cleanup(func() { crashRestartBackoff, crashRestartWindow = origBackoff, origWindow })
}

// TestLauncherAutoRestartsCrashedInstanceInPlace ist die Kern-
// Verifikation aus dem Phasenplan (docs/END-GOAL-FEATURES.md §7.4
// K7-Teil-1): ein abgestürzter Prozess wird unter **derselben**
// Instanz-ID neu gestartet (nicht als neue Instanz), mit hochgezähltem
// RestartCount, Crashed wieder false, und der RestartObserver wird
// benachrichtigt.
func TestLauncherAutoRestartsCrashedInstanceInPlace(t *testing.T) {
	shortCrashRestartTiming(t, 50*time.Millisecond, time.Minute)

	// Stirbt beim ersten Start (Marker-Datei fehlt noch), überlebt ab dem
	// Neustart (Marker-Datei wurde beim ersten, gescheiterten Versuch
	// angelegt) — simuliert einen einmaligen, sich selbst heilenden Fehler
	// ohne einen externen Zähler-Mechanismus im Testskript zu brauchen.
	marker := t.TempDir() + "/seen"
	catalog := []CatalogEntry{{
		Type:   "flaky",
		Label:  "Flaky",
		Runner: "process",
		Command: []string{
			"/bin/sh", "-c",
			"if [ -e " + marker + " ]; then exec sleep 30; else touch " + marker + "; exit 1; fi",
		},
	}}
	pub := &recordingPublisher{}
	obs := &recordingRestartObserver{}
	l := New(catalog, "http://registry", "nats://nats", t.TempDir(), pub, nil)
	l.SetRestartObserver(obs)

	inst, err := l.Start("flaky", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var list []Instance
	for time.Now().Before(deadline) {
		list = l.List()
		if len(list) == 1 && !list[0].Crashed && list[0].RestartCount > 0 && list[0].PID != inst.PID {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer func() { _ = l.Stop(inst.ID) }()

	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry for the same instance id %s (restart-in-place)", list, inst.ID)
	}
	if list[0].Crashed {
		t.Errorf("List()[0].Crashed = true, want false after a successful auto-restart")
	}
	if list[0].RestartCount != 1 {
		t.Errorf("List()[0].RestartCount = %d, want 1", list[0].RestartCount)
	}
	if list[0].PID == inst.PID {
		t.Errorf("List()[0].PID = %d, want a different PID than the original %d (in-place restart replaces the process)", list[0].PID, inst.PID)
	}
	if !processAlive(list[0].PID) {
		t.Errorf("restarted process (PID %d) is not alive", list[0].PID)
	}

	events := pub.snapshot()
	foundRestarted := false
	for _, e := range events {
		if e.Type == "instance.restarted" && strings.Contains(string(e.Data), inst.ID) {
			foundRestarted = true
		}
	}
	if !foundRestarted {
		t.Errorf("Broadcast events = %+v, want an instance.restarted event containing %s", events, inst.ID)
	}

	obsIDs := obs.snapshot()
	if len(obsIDs) != 1 || obsIDs[0] != inst.ID {
		t.Errorf("RestartObserver.InstanceRestarted calls = %v, want exactly [%s]", obsIDs, inst.ID)
	}
}

// TestLauncherCrashLoopBrakeStopsAutoRestarting verifiziert die
// Crash-Loop-Bremse (docs/decisions.md 2026-07-14 Kapitel-10-
// Entscheidung Punkt 8): ein Prozess, der immer wieder sofort abstürzt,
// darf nicht endlos neu gestartet werden — nach maxCrashRestarts
// Versuchen innerhalb des Fensters bleibt die Instanz crashed stehen.
func TestLauncherCrashLoopBrakeStopsAutoRestarting(t *testing.T) {
	shortCrashRestartTiming(t, 10*time.Millisecond, time.Minute)
	origMax := maxCrashRestarts
	maxCrashRestarts = 2
	t.Cleanup(func() { maxCrashRestarts = origMax })

	crashing := []CatalogEntry{{
		Type:    "loopy",
		Label:   "Loopy",
		Runner:  "process",
		Command: []string{"/bin/sh", "-c", "exit 1"},
	}}
	pub := &recordingPublisher{}
	l := New(crashing, "http://registry", "nats://nats", t.TempDir(), pub, nil)

	inst, err := l.Start("loopy", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var list []Instance
	for time.Now().Before(deadline) {
		list = l.List()
		if len(list) == 1 && list[0].Crashed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(list) != 1 || !list[0].Crashed {
		t.Fatalf("List() = %+v, want the instance to end up crashed once the crash-loop brake trips", list)
	}
	// RestartCount zählt jedes unerwartete Prozessende, auch das letzte,
	// das die Bremse auslöst (nicht nur die tatsächlich erfolgten
	// Neustarts) — bei maxCrashRestarts=2 sind das 2 Neustarts plus der
	// 3. Absturz, bei dem countInWindow die Grenze überschreitet und
	// eskaliert wird.
	wantRestartCount := maxCrashRestarts + 1
	if list[0].RestartCount != wantRestartCount {
		t.Errorf("List()[0].RestartCount = %d, want %d", list[0].RestartCount, wantRestartCount)
	}
	if !strings.Contains(list[0].CrashMessage, "Crash-Loop") {
		t.Errorf("CrashMessage = %q, want it to mention the crash-loop brake", list[0].CrashMessage)
	}

	// Sicherstellen, dass wirklich nicht weiter neu gestartet wird: PID
	// und RestartCount bleiben über eine weitere Backoff-Periode hinweg
	// stabil.
	time.Sleep(200 * time.Millisecond)
	after := l.List()
	if len(after) != 1 || after[0].RestartCount != list[0].RestartCount {
		t.Errorf("instance kept changing after the crash-loop brake tripped: before=%+v after=%+v", list[0], after)
	}

	_ = l.Stop(inst.ID)
}

// fakeNATSRequester ist ein Test-Double für NATSRequester — zeichnet
// die zuletzt gesendete Subject/Payload-Kombination auf und liefert
// eine vorgegebene Antwort (oder einen Fehler), ohne echtes NATS.
type fakeNATSRequester struct {
	lastSubject string
	lastPayload []byte
	response    remoteResponse
	err         error
}

func (f *fakeNATSRequester) RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	f.lastSubject = subject
	f.lastPayload = data
	if f.err != nil {
		return nil, f.err
	}
	return json.Marshal(f.response)
}

func TestLauncherStartRemoteWithoutNATSReturnsError(t *testing.T) {
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, nil)

	if _, err := l.Start("sleepy", "host-1", nil); err != ErrRemoteUnavailable {
		t.Fatalf("Start() error = %v, want ErrRemoteUnavailable", err)
	}
}

func TestLauncherStartRemoteSendsCorrectSubjectAndSucceeds(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 4242}}
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, fake)

	// Remote-Start prüft nicht gegen den eigenen (hier: lokalen)
	// Katalog — der Host-Agent hat seinen eigenen, s. Paketkommentar —
	// deshalb funktioniert ein beim Orchestrator unbekannter Typ hier
	// bewusst trotzdem.
	inst, err := l.Start("omp-source", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if inst.HostID != "host-1" || inst.PID != 4242 || inst.Type != "omp-source" {
		t.Fatalf("Start() = %+v, unexpected", inst)
	}
	if fake.lastSubject != "omp.host.host-1.cmd" {
		t.Errorf("subject = %q, want omp.host.host-1.cmd", fake.lastSubject)
	}
	var sent remoteCommand
	if err := json.Unmarshal(fake.lastPayload, &sent); err != nil {
		t.Fatalf("payload not valid JSON: %v", err)
	}
	if sent.Action != "start" || sent.Type != "omp-source" || sent.InstanceID != inst.ID {
		t.Errorf("sent command = %+v, unexpected", sent)
	}

	list := l.List()
	if len(list) != 1 || list[0].HostID != "host-1" {
		t.Fatalf("List() = %+v, want one remote instance", list)
	}
}

func TestLauncherStartRemoteFailureResponse(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: false, Error: "unknown catalog type"}}
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, fake)

	if _, err := l.Start("omp-source", "host-1", nil); err == nil {
		t.Fatal("Start() error = nil, want an error for a failed remote response")
	}
	if len(l.List()) != 0 {
		t.Errorf("List() = %+v, want empty after a failed remote start", l.List())
	}
}

func TestLauncherStopRemoteSendsStopCommand(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 4242}}
	l := New(sleepyCatalog(), "http://registry", "nats://nats", t.TempDir(), nil, fake)

	inst, err := l.Start("omp-source", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	fake.response = remoteResponse{OK: true}
	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	var sent remoteCommand
	if err := json.Unmarshal(fake.lastPayload, &sent); err != nil {
		t.Fatalf("payload not valid JSON: %v", err)
	}
	if sent.Action != "stop" || sent.InstanceID != inst.ID {
		t.Errorf("sent command = %+v, unexpected", sent)
	}
	if len(l.List()) != 0 {
		t.Errorf("List() = %+v, want empty after Stop()", l.List())
	}
}

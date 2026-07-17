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

// fakeInstanceStore ist ein In-Memory-Test-Double für instanceStore
// (S4, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — für Tests, denen es
// nicht um die Postgres-Persistenz selbst geht (die hat store_test.go
// gegen eine echte Datenbank), gleiches Muster wie workflows_test.go's
// fakeStore. Eine Instanz kann über zwei Launcher hinweg geteilt werden
// (newFakeInstanceStore() einmal aufrufen, an beide New()-Aufrufe
// übergeben), um einen Orchestrator-Neustart zu simulieren, ohne eine
// echte Datenbank zu brauchen.
type fakeInstanceStore struct {
	mu   sync.Mutex
	data map[string]Instance
}

func newFakeInstanceStore() *fakeInstanceStore {
	return &fakeInstanceStore{data: map[string]Instance{}}
}

func (s *fakeInstanceStore) Put(inst Instance) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[inst.ID] = inst
	return nil
}

func (s *fakeInstanceStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, id)
	return nil
}

func (s *fakeInstanceStore) List() ([]Instance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Instance, 0, len(s.data))
	for _, inst := range s.data {
		out = append(out, inst)
	}
	return out, nil
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
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)

	if _, err := l.Start("does-not-exist", "", nil); err != ErrUnknownType {
		t.Fatalf("Start() error = %v, want ErrUnknownType", err)
	}
}

func TestLauncherStartUnsupportedRunnerReturnsError(t *testing.T) {
	catalog := []CatalogEntry{{Type: "x", Label: "X", Runner: "podman", Command: []string{"true"}}}
	l := newWithStore(catalog, "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)

	if _, err := l.Start("x", "", nil); err != ErrUnsupportedRunner {
		t.Fatalf("Start() error = %v, want ErrUnsupportedRunner", err)
	}
}

func TestLauncherStartAppearsInListAndStopRemovesIt(t *testing.T) {
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)

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

	l := newWithStore(stubbornCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)
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
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)
	if err := l.Stop("does-not-exist"); err != ErrUnknownInstance {
		t.Fatalf("Stop() error = %v, want ErrUnknownInstance", err)
	}
}

// TestLauncherReloadsStillRunningInstanceAfterRestart läuft seit S4
// (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) gegen eine echte,
// migrierte Postgres-Datenbank statt gegen data/instances.json — die
// beiden Launcher (l1/l2, simulieren einen Orchestrator-Neustart) teilen
// sich denselben *Store auf derselben Datenbankverbindung.
func TestLauncherReloadsStillRunningInstanceAfterRestart(t *testing.T) {
	store := NewStore(testDB(t))
	l1 := New(sleepyCatalog(), "http://registry", "nats://nats", store, nil, nil)
	inst, err := l1.Start("sleepy", "", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() { _ = l1.Stop(inst.ID) }()

	l2 := New(sleepyCatalog(), "http://registry", "nats://nats", store, nil, nil)
	list := l2.List()
	if len(list) != 1 || list[0].ID != inst.ID || list[0].PID != inst.PID {
		t.Fatalf("List() after restart = %+v, want the still-running instance %+v", list, inst)
	}
}

// TestLauncherDropsDeadInstanceAfterRestart — gleicher Grund wie oben:
// echte Datenbank statt Datei, S4.
func TestLauncherDropsDeadInstanceAfterRestart(t *testing.T) {
	disableAutoRestart(t)
	store := NewStore(testDB(t))
	quickExit := []CatalogEntry{{Type: "quick", Label: "Quick", Runner: "process", Command: []string{"/bin/sh", "-c", "exit 0"}}}

	l1 := New(quickExit, "http://registry", "nats://nats", store, nil, nil)
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

	l2 := New(quickExit, "http://registry", "nats://nats", store, nil, nil)
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
	l := newWithStore(catalog, "http://registry:8010", "nats://nats:4222", newFakeInstanceStore(), nil, nil)

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
	l := newWithStore(catalog, "http://registry:8010", "nats://nats:4222", newFakeInstanceStore(), nil, nil)

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
	l := newWithStore(crashing, "http://registry", "nats://nats", newFakeInstanceStore(), pub, nil)

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
	l := newWithStore(catalog, "http://registry", "nats://nats", newFakeInstanceStore(), pub, nil)
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
	l := newWithStore(crashing, "http://registry", "nats://nats", newFakeInstanceStore(), pub, nil)

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
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, nil)

	if _, err := l.Start("sleepy", "host-1", nil); err != ErrRemoteUnavailable {
		t.Fatalf("Start() error = %v, want ErrRemoteUnavailable", err)
	}
}

func TestLauncherStartRemoteSendsCorrectSubjectAndSucceeds(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 4242}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

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
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

	if _, err := l.Start("omp-source", "host-1", nil); err == nil {
		t.Fatal("Start() error = nil, want an error for a failed remote response")
	}
	if len(l.List()) != 0 {
		t.Errorf("List() = %+v, want empty after a failed remote start", l.List())
	}
}

func TestLauncherStopRemoteSendsStopCommand(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 4242}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

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

// --- S3: HandleRemoteExit (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) ---

func exitEventJSON(t *testing.T, instanceID string, exitCode int, stderrTail string) []byte {
	t.Helper()
	data, err := json.Marshal(remoteExitEvent{InstanceID: instanceID, ExitCode: exitCode, StderrTail: stderrTail})
	if err != nil {
		t.Fatalf("marshal exit event: %v", err)
	}
	return data
}

// TestHandleRemoteExitRestartsInPlaceAndNotifiesObserver ist das
// Remote-Pendant zu TestLauncherAutoRestartsCrashedInstanceInPlace:
// dieselbe Instanz-ID, hochgezähltes RestartCount, instance.restarted-
// Event, RestartObserver benachrichtigt — nur über ein Remote-Start-
// Kommando statt eines lokalen os/exec-Aufrufs.
func TestHandleRemoteExitRestartsInPlaceAndNotifiesObserver(t *testing.T) {
	shortCrashRestartTiming(t, 10*time.Millisecond, time.Minute)
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 4242}}
	pub := &recordingPublisher{}
	obs := &recordingRestartObserver{}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), pub, fake)
	l.SetRestartObserver(obs)

	inst, err := l.Start("omp-source", "host-1", map[string]string{"OMP_WIDTH": "1280"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	fake.response = remoteResponse{OK: true, PID: 9999}
	l.HandleRemoteExit("host-1", exitEventJSON(t, inst.ID, 1, "boom"))

	list := l.List()
	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry for %s (restart-in-place)", list, inst.ID)
	}
	if list[0].Crashed {
		t.Errorf("List()[0].Crashed = true, want false after a successful auto-restart")
	}
	if list[0].RestartCount != 1 {
		t.Errorf("List()[0].RestartCount = %d, want 1", list[0].RestartCount)
	}
	if list[0].PID != 9999 {
		t.Errorf("List()[0].PID = %d, want 9999 (from the restart response)", list[0].PID)
	}

	var sent remoteCommand
	if err := json.Unmarshal(fake.lastPayload, &sent); err != nil {
		t.Fatalf("payload not valid JSON: %v", err)
	}
	if sent.Action != "start" || sent.Type != "omp-source" || sent.InstanceID != inst.ID {
		t.Errorf("sent restart command = %+v, unexpected", sent)
	}
	if sent.ExtraEnv["OMP_WIDTH"] != "1280" {
		t.Errorf("sent restart command ExtraEnv = %+v, want OMP_WIDTH=1280 (replayed from the original start)", sent.ExtraEnv)
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

// TestHandleRemoteExitCrashLoopBrakeStopsAutoRestarting ist das
// Remote-Pendant zu TestLauncherCrashLoopBrakeStopsAutoRestarting.
func TestHandleRemoteExitCrashLoopBrakeStopsAutoRestarting(t *testing.T) {
	shortCrashRestartTiming(t, time.Millisecond, time.Minute)
	origMax := maxCrashRestarts
	maxCrashRestarts = 2
	t.Cleanup(func() { maxCrashRestarts = origMax })

	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 1111}}
	pub := &recordingPublisher{}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), pub, fake)

	inst, err := l.Start("omp-source", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	// maxCrashRestarts=2: die ersten beiden Exit-Events lösen noch einen
	// Neustart aus, das dritte trifft auf die Bremse.
	l.HandleRemoteExit("host-1", exitEventJSON(t, inst.ID, 1, "crash 1"))
	l.HandleRemoteExit("host-1", exitEventJSON(t, inst.ID, 1, "crash 2"))
	l.HandleRemoteExit("host-1", exitEventJSON(t, inst.ID, 1, "crash 3"))

	list := l.List()
	if len(list) != 1 || list[0].ID != inst.ID {
		t.Fatalf("List() = %+v, want one entry for %s", list, inst.ID)
	}
	if !list[0].Crashed {
		t.Errorf("List()[0].Crashed = false after exceeding maxCrashRestarts, want true")
	}
	if !strings.Contains(list[0].CrashMessage, "Crash-Loop erkannt") {
		t.Errorf("CrashMessage = %q, want it to mention the crash-loop brake", list[0].CrashMessage)
	}

	events := pub.snapshot()
	foundCrashed := false
	for _, e := range events {
		if e.Type == "instance.crashed" && strings.Contains(string(e.Data), inst.ID) {
			foundCrashed = true
		}
	}
	if !foundCrashed {
		t.Errorf("Broadcast events = %+v, want an instance.crashed event containing %s", events, inst.ID)
	}
}

// TestHandleRemoteExitIgnoresUnknownInstance — ein Exit-Event für eine
// nicht (mehr) getrackte Instanz (z. B. bereits per Stop() entfernt,
// Race zwischen Stop() und Prozessende) darf keinen Neustart auslösen.
func TestHandleRemoteExitIgnoresUnknownInstance(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 1}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

	l.HandleRemoteExit("host-1", exitEventJSON(t, "does-not-exist", 1, ""))

	if fake.lastSubject != "" {
		t.Errorf("lastSubject = %q, want no command sent for an unknown instance", fake.lastSubject)
	}
	if len(l.List()) != 0 {
		t.Errorf("List() = %+v, want empty", l.List())
	}
}

// TestHandleRemoteExitIgnoresEventFromWrongHost — Vertrauensgrenze:
// ein Exit-Event, dessen Subject-hostID nicht zum HostID der getrackten
// Instanz passt, wird ignoriert (kein Host kann im Namen eines anderen
// Hosts einen Neustart auslösen).
func TestHandleRemoteExitIgnoresEventFromWrongHost(t *testing.T) {
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 1}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

	inst, err := l.Start("omp-source", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	fake.lastSubject = "" // Start() selbst hat schon ein Kommando gesendet — zurücksetzen

	l.HandleRemoteExit("host-2", exitEventJSON(t, inst.ID, 1, ""))

	if fake.lastSubject != "" {
		t.Errorf("lastSubject = %q, want no restart command sent for an event from the wrong host", fake.lastSubject)
	}
	list := l.List()
	if len(list) != 1 || list[0].Crashed {
		t.Errorf("List() = %+v, want the instance untouched (not marked crashed) by a foreign-host event", list)
	}
}

// TestHandleRemoteExitStopDuringBackoffSkipsRestart — Stop() während
// des crashRestartBackoff-Delays muss den Neustart verhindern (gleiche
// Race-Absicherung wie supervise()'s lokaler Pfad).
func TestHandleRemoteExitStopDuringBackoffSkipsRestart(t *testing.T) {
	shortCrashRestartTiming(t, 200*time.Millisecond, time.Minute)
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 1}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake)

	inst, err := l.Start("omp-source", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	done := make(chan struct{})
	go func() {
		l.HandleRemoteExit("host-1", exitEventJSON(t, inst.ID, 1, ""))
		close(done)
	}()

	time.Sleep(20 * time.Millisecond) // sicherstellen, dass HandleRemoteExit schon im Backoff-Sleep steckt
	if err := l.Stop(inst.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	<-done

	if len(l.List()) != 0 {
		t.Errorf("List() = %+v, want empty (Stop() during backoff must win)", l.List())
	}
}

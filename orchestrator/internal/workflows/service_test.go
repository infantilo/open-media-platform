package workflows

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeStore struct {
	mu  sync.Mutex
	wfs map[string]Workflow
}

func newFakeStore() *fakeStore { return &fakeStore{wfs: map[string]Workflow{}} }

func (f *fakeStore) Put(wf Workflow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wfs[wf.ID] = wf
	return nil
}

func (f *fakeStore) Get(id string) (Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	wf, ok := f.wfs[id]
	if !ok {
		return Workflow{}, ErrNotFound
	}
	return wf, nil
}

func (f *fakeStore) List() ([]Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Workflow, 0, len(f.wfs))
	for _, wf := range f.wfs {
		out = append(out, wf)
	}
	return out, nil
}

func (f *fakeStore) Delete(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.wfs, id)
	return nil
}

type fakeNodeLister struct {
	mu    sync.Mutex
	nodes []registry.NodeView
}

func (f *fakeNodeLister) List() []registry.NodeView {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]registry.NodeView, len(f.nodes))
	copy(out, f.nodes)
	return out
}

func (f *fakeNodeLister) add(n registry.NodeView) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodes = append(f.nodes, n)
}

type connectCall struct{ fromSender, toReceiver string }

type fakeGraph struct {
	mu    sync.Mutex
	calls []connectCall
	err   error
}

func (f *fakeGraph) Connect(ctx context.Context, fromSender, toReceiver string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, connectCall{fromSender, toReceiver})
	return f.err
}

type fakeLauncher struct {
	mu        sync.Mutex
	started   []string          // nodeType per call
	instances map[string]string // nodeType -> instanceID of the last Start() call for that type
	startErr  error
	stopped   []string // instanceID per call
	stopErrs  map[string]error
}

func (f *fakeLauncher) Start(nodeType, hostID string) (launcher.Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return launcher.Instance{}, f.startErr
	}
	f.started = append(f.started, nodeType)
	id := nodeType + "-instance-" + strconv.Itoa(len(f.started))
	if f.instances == nil {
		f.instances = map[string]string{}
	}
	f.instances[nodeType] = id
	return launcher.Instance{ID: id, Type: nodeType, HostID: hostID}, nil
}

func (f *fakeLauncher) Stop(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, id)
	if f.stopErrs != nil {
		return f.stopErrs[id]
	}
	return nil
}

func (f *fakeLauncher) instanceIDFor(nodeType string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.instances[nodeType]
}

// newTestService baut einen Service direkt per Struct-Literal statt über
// NewService (das eine konkrete *Store, keine Fakes, erwartet) — gleiches
// Muster wie internal/snapshots.newTestService.
func newTestService(store workflowStore, nodes NodeLister, g GraphService, l Launcher) *Service {
	return &Service{store: store, nodes: nodes, graph: g, launcher: l}
}

func waitForStatus(t *testing.T, svc *Service, id, status string) Workflow {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		wf, err := svc.Get(id)
		if err != nil {
			t.Fatalf("Get() error = %v", err)
		}
		if wf.Status == status {
			return wf
		}
		time.Sleep(10 * time.Millisecond)
	}
	wf, _ := svc.Get(id)
	t.Fatalf("timed out waiting for status %q, last status = %q (error=%q)", status, wf.Status, wf.Error)
	return Workflow{}
}

func TestCreateRejectsEmptyRoles(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	_, err := svc.Create("empty", Definition{})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsUnknownConnectionRole(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:       []Role{{Name: "src", NodeType: "omp-source"}},
		Connections: []Connection{{FromRole: "src", ToRole: "does-not-exist"}},
	}
	_, err := svc.Create("bad", def)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateAndListRoundTrip(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}
	wf, err := svc.Create("my workflow", def)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if wf.Status != StatusStopped {
		t.Errorf("Status = %q, want stopped", wf.Status)
	}
	list, err := svc.List()
	if err != nil || len(list) != 1 || list[0].ID != wf.ID {
		t.Fatalf("List() = %+v, err=%v, want one workflow with ID %s", list, err, wf.ID)
	}
}

func TestDeleteRequiresStopped(t *testing.T) {
	store := newFakeStore()
	svc := &Service{store: store}
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})

	running := wf
	running.Status = StatusStarted
	store.Put(running)

	if err := svc.Delete(wf.ID); !errors.Is(err, ErrNotStopped) {
		t.Fatalf("Delete() error = %v, want ErrNotStopped", err)
	}

	stopped := wf
	stopped.Status = StatusStopped
	store.Put(stopped)
	if err := svc.Delete(wf.ID); err != nil {
		t.Fatalf("Delete() error = %v, want nil", err)
	}
}

func TestStartProvisionsRolesAndConnectsOnRegistration(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"},
			{Name: "view", NodeType: "omp-viewer"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "view"}},
	}
	wf, err := svc.Create("regie", def)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	starting, _ := svc.Get(wf.ID)
	if starting.Status != StatusStarting {
		t.Fatalf("Status right after Start() = %q, want starting", starting.Status)
	}

	// Registrierung simulieren, nachdem der Launcher "gestartet" hat.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		startedCount := len(l.started)
		l.mu.Unlock()
		if startedCount == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	srcInstance, viewInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-1"}}})
	nodes.add(registry.NodeView{ID: "node-view", InstanceID: viewInstance, Receivers: []registry.ReceiverView{{ID: "recv-1"}}})

	started := waitForStatus(t, svc, wf.ID, StatusStarted)
	if started.Runtime["src"].NodeID != "node-src" || started.Runtime["view"].NodeID != "node-view" {
		t.Fatalf("Runtime = %+v, want resolved node IDs", started.Runtime)
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 1 || g.calls[0].fromSender != "send-1" || g.calls[0].toReceiver != "recv-1" {
		t.Fatalf("connect calls = %+v, want one send-1 -> recv-1", g.calls)
	}
}

// TestInstanceRestartedRewiresAffectedRole ist die workflows-Seite von
// K7-Teil-1 (docs/END-GOAL-FEATURES.md §7.3a/§7.6, launcher.
// RestartObserver): nachdem eine Rollen-Instanz vom Launcher automatisch
// neu gestartet wurde (neue Registrierung unter derselben Instanz-ID,
// aber neuer Node-/Sender-ID — ein Neustart bekommt i. d. R. eine neue
// NMOS-Node-Identität), muss der Workflow die betroffene Connection neu
// auflösen, ohne dass der Nutzer den Workflow manuell neu startet.
func TestInstanceRestartedRewiresAffectedRole(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"},
			{Name: "view", NodeType: "omp-viewer"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "view"}},
	}
	wf, err := svc.Create("regie", def)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		startedCount := len(l.started)
		l.mu.Unlock()
		if startedCount == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	srcInstance, viewInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-1"}}})
	nodes.add(registry.NodeView{ID: "node-view", InstanceID: viewInstance, Receivers: []registry.ReceiverView{{ID: "recv-1"}}})
	waitForStatus(t, svc, wf.ID, StatusStarted)

	g.mu.Lock()
	initialCalls := len(g.calls)
	g.mu.Unlock()
	if initialCalls != 1 {
		t.Fatalf("connect calls after start = %d, want 1", initialCalls)
	}

	// Neustart simulieren: die alte Registrierung ist bewusst noch NICHT
	// weg (per SIGKILL beendete Prozesse melden sich nicht selbst ab —
	// die alte NMOS-Registrierung lebt bis zu ihrem Heartbeat-Timeout
	// neben der neuen weiter). Live per kill -9 gefunden: ohne die
	// excludeNodeID-Unterscheidung in awaitFreshRegistration matcht
	// findByInstanceID sofort die alte, noch nicht abgelaufene
	// Registrierung und die Connection bleibt auf deren (bald totem)
	// Sender stehen, statt auf den neuen umzuschwenken.
	nodes.add(registry.NodeView{ID: "node-src-2", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-2"}}})
	svc.InstanceRestarted(srcInstance)

	deadline = time.Now().Add(2 * time.Second)
	var wfAfter Workflow
	for time.Now().Before(deadline) {
		wfAfter, err = svc.Get(wf.ID)
		if err != nil {
			t.Fatalf("Get() error = %v", err)
		}
		if wfAfter.Runtime["src"].NodeID == "node-src-2" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if wfAfter.Runtime["src"].NodeID != "node-src-2" {
		t.Fatalf("Runtime[\"src\"].NodeID = %q, want it updated to node-src-2 after the restart", wfAfter.Runtime["src"].NodeID)
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("connect calls after restart = %+v, want a second call with the new sender", g.calls)
	}
	if g.calls[1].fromSender != "send-2" || g.calls[1].toReceiver != "recv-1" {
		t.Errorf("second connect call = %+v, want send-2 -> recv-1", g.calls[1])
	}
}

// TestInstanceRestartedIgnoresInstanceOutsideAnyWorkflow stellt sicher,
// dass ein direkt über den Katalog gestarteter Node (kein Workflow)
// keinen Effekt hat — InstanceRestarted muss dafür still bleiben, nicht
// mit einem Fehler oder einem Registrierungs-Timeout enden.
func TestInstanceRestartedIgnoresInstanceOutsideAnyWorkflow(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	svc.InstanceRestarted("some-standalone-instance")
	// rewireAfterRestart läuft in einer eigenen Goroutine — kurz Zeit
	// geben, damit ein eventueller (falscher) Zugriff überhaupt
	// stattfinden könnte, dann prüfen, dass nichts angelegt wurde.
	time.Sleep(50 * time.Millisecond)
	wfs, err := svc.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(wfs) != 0 {
		t.Errorf("List() = %+v, want no workflows created as a side effect", wfs)
	}
}

func TestStartFailsWhenRegistrationTimesOut(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 100 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	failed := waitForStatus(t, svc, wf.ID, StatusFailed)
	if failed.Error == "" {
		t.Errorf("Error = %q, want a timeout message", failed.Error)
	}
}

func TestStartFailsWhenLauncherErrors(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{startErr: errors.New("boom")})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	failed := waitForStatus(t, svc, wf.ID, StatusFailed)
	if failed.Error == "" {
		t.Errorf("Error = %q, want a launcher-error message", failed.Error)
	}
}

func TestStopStopsAllRunningRoles(t *testing.T) {
	store := newFakeStore()
	l := &fakeLauncher{}
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, l)

	wf, _ := svc.Create("wf", Definition{Roles: []Role{
		{Name: "src", NodeType: "omp-source"},
		{Name: "view", NodeType: "omp-viewer"},
	}})
	running := wf
	running.Status = StatusStarted
	running.Runtime = map[string]RoleRuntime{
		"src":  {InstanceID: "inst-src", NodeID: "node-src"},
		"view": {InstanceID: "inst-view", NodeID: "node-view"},
	}
	store.Put(running)

	if err := svc.Stop(context.Background(), wf.ID); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}

	stopped := waitForStatus(t, svc, wf.ID, StatusStopped)
	if len(stopped.Runtime) != 0 {
		t.Errorf("Runtime = %+v, want empty after stop", stopped.Runtime)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.stopped) != 2 {
		t.Fatalf("stopped instances = %v, want 2", l.stopped)
	}
}

func TestStopRequiresRunning(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})

	if err := svc.Stop(context.Background(), wf.ID); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Stop() error = %v, want ErrNotRunning", err)
	}
}

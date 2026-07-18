package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher ist ein Test-Double für EventPublisher, das nur die
// Typen der empfangenen Events sammelt (gleiches Muster wie
// graph_test.go/audit_test.go).
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }

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

func (f *fakeStore) UpdateSchedules(id string, schedules []Schedule) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	wf, ok := f.wfs[id]
	if !ok {
		return ErrNotFound
	}
	wf.Definition.Schedules = schedules
	f.wfs[id] = wf
	return nil
}

// UpdateRuntime spiegelt Store.UpdateRuntime: übernimmt alles außer
// Definition.Schedules, die bleiben auf dem zuletzt in der Map
// gespeicherten Stand (gleiche "DB gewinnt bei schedules"-Semantik wie
// die echte jsonb_set-Variante).
func (f *fakeStore) UpdateRuntime(wf Workflow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.wfs[wf.ID]; ok {
		wf.Definition.Schedules = existing.Definition.Schedules
	}
	f.wfs[wf.ID] = wf
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

type methodCall struct {
	baseURL, method string
	args            map[string]any
}

// fakeMethodInvoker ist ein Test-Double für methodInvoker (nodeclient.go)
// — sammelt Crosspoint-Methodenaufrufe statt echter HTTP-Requests
// (docs/decisions.md 2026-07-18: Crosspoint-Zielrollen ohne
// IS-04-Receiver).
type fakeMethodInvoker struct {
	mu     sync.Mutex
	calls  []methodCall
	err    error
	inputs []string // von GetParam als [{"senderId": ...}, ...] gemeldete Sender-IDs
}

func (f *fakeMethodInvoker) Invoke(ctx context.Context, baseURL, method string, args map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, methodCall{baseURL, method, args})
	return f.err
}

func (f *fakeMethodInvoker) GetParam(ctx context.Context, baseURL, name string) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	type input struct {
		SenderID string `json:"senderId"`
	}
	inputs := make([]input, 0, len(f.inputs))
	for _, id := range f.inputs {
		inputs = append(inputs, input{SenderID: id})
	}
	return json.Marshal(inputs)
}

type fakeLauncher struct {
	mu        sync.Mutex
	started   []string          // nodeType per call
	instances map[string]string // nodeType -> instanceID of the last Start() call for that type
	startErr  error
	stopped   []string // instanceID per call
	stopErrs  map[string]error
	// lastExtraEnv (Kapitel 15, §15.3c) — das extraEnv der zuletzt
	// beobachteten Start()-Aufrufe, ein Eintrag pro nodeType.
	lastExtraEnv map[string]map[string]string
}

func (f *fakeLauncher) Start(nodeType, hostID string, extraEnv map[string]string) (launcher.Instance, error) {
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
	if f.lastExtraEnv == nil {
		f.lastExtraEnv = map[string]map[string]string{}
	}
	f.lastExtraEnv[nodeType] = extraEnv
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

// TestCreatePublishesWorkflowUpdated ist ein S2-Regressionstest
// (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): per Live-CDP-Test
// gefunden, dass Create() als einziger Schreibpfad kein "workflow.
// updated" broadcastete — ein extern (nicht über workflows-view.ts'
// eigenes #createWorkflow(), das nach dem POST selbst pollt) angelegter
// Workflow blieb dadurch in jedem anderen offenen Tab bis zum
// 30s-Fallback-Poll unsichtbar.
func TestCreatePublishesWorkflowUpdated(t *testing.T) {
	pub := &fakeEventPublisher{}
	svc := &Service{store: newFakeStore(), events: pub}

	if _, err := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if len(pub.types) != 1 || pub.types[0] != "workflow.updated" {
		t.Errorf("published events = %v, want [workflow.updated]", pub.types)
	}
}

// TestDeletePublishesWorkflowUpdated — gleicher Grund wie bei Create().
func TestDeletePublishesWorkflowUpdated(t *testing.T) {
	store := newFakeStore()
	svc := &Service{store: store}
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})

	pub := &fakeEventPublisher{}
	svc.events = pub
	if err := svc.Delete(wf.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	if len(pub.types) != 1 || pub.types[0] != "workflow.updated" {
		t.Errorf("published events = %v, want [workflow.updated]", pub.types)
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

// TestStartResolvesConnectionByLabel deckt Kapitel 12 Teil 1
// (docs/END-GOAL-FEATURES.md §12.3a) ab: omp-source registriert zwei
// unbenannte Sender (Video, Audio) in dieser Reihenfolge — ohne
// FromSender-Label würde immer der erste (Video) gewählt.
func TestStartResolvesConnectionByLabel(t *testing.T) {
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
		Connections: []Connection{{FromRole: "src", FromSender: "Audio", ToRole: "view"}},
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
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{
		{ID: "send-video", Label: "Video"},
		{ID: "send-audio", Label: "Audio"},
	}})
	nodes.add(registry.NodeView{ID: "node-view", InstanceID: viewInstance, Receivers: []registry.ReceiverView{{ID: "recv-1"}}})

	waitForStatus(t, svc, wf.ID, StatusStarted)

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 1 || g.calls[0].fromSender != "send-audio" {
		t.Fatalf("connect calls = %+v, want one send-audio -> recv-1", g.calls)
	}
}

// TestStartResolvesCrosspointConnectionViaMethodInvoke deckt die
// Kapitel-12-Erweiterung ab (docs/decisions.md 2026-07-18): eine
// Zielrolle ohne IS-04-Receiver, aber mit bekanntem Crosspoint-Node-Typ
// (omp-video-mixer-me), wird über einen Methodenaufruf statt IS-05
// Connect verkabelt — kein graph.Connect-Aufruf.
func TestStartResolvesCrosspointConnectionViaMethodInvoke(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	methods := &fakeMethodInvoker{}
	svc := newTestService(newFakeStore(), nodes, g, l)
	svc.methods = methods

	def := Definition{
		Roles: []Role{
			{Name: "cam1", NodeType: "omp-source"},
			{Name: "mix", NodeType: "omp-video-mixer-me"},
		},
		Connections: []Connection{{FromRole: "cam1", ToRole: "mix"}},
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

	camInstance, mixInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-video-mixer-me")
	nodes.add(registry.NodeView{ID: "node-cam1", InstanceID: camInstance, Senders: []registry.SenderView{{ID: "send-cam1"}}})
	nodes.add(registry.NodeView{ID: "node-mix", InstanceID: mixInstance, APIBaseURL: "http://node-mix:9360"})
	// Simuliert den (in Wirklichkeit asynchronen) discovery_loop des
	// Zielnodes, der "send-cam1" irgendwann selbst entdeckt — ohne das
	// würde waitForCrosspointInput bis registrationTimeout warten und
	// der Workflow in "failed" statt "started" enden (s. Live-Fund
	// 2026-07-18, docs/decisions.md).
	methods.mu.Lock()
	methods.inputs = []string{"send-cam1"}
	methods.mu.Unlock()

	waitForStatus(t, svc, wf.ID, StatusStarted)

	g.mu.Lock()
	graphCalls := len(g.calls)
	g.mu.Unlock()
	if graphCalls != 0 {
		t.Fatalf("graph.Connect calls = %d, want 0 (crosspoint target must not use IS-05)", graphCalls)
	}

	methods.mu.Lock()
	defer methods.mu.Unlock()
	if len(methods.calls) != 1 {
		t.Fatalf("method invoke calls = %+v, want exactly one", methods.calls)
	}
	call := methods.calls[0]
	if call.baseURL != "http://node-mix:9360" || call.method != "crosspoint.take" || call.args["senderId"] != "send-cam1" {
		t.Fatalf("method call = %+v, want crosspoint.take(senderId=send-cam1) on node-mix", call)
	}
}

// TestStartFailsWhenCrosspointInputNeverAppears deckt den Live-Fund vom
// 2026-07-18 ab (docs/decisions.md): eine Crosspoint-Zielrolle, die den
// gewünschten Sender nie unter ihren entdeckten Eingängen meldet
// (discovery_loop lief nicht/anders), darf den Take()-Aufruf nicht
// einfach verlieren — der Workflow muss "failed" mit erklärender
// Fehlermeldung enden, statt "started" ohne wirksame Verkabelung.
func TestStartFailsWhenCrosspointInputNeverAppears(t *testing.T) {
	// 300ms statt der sonst üblichen 100ms (s. TestStartFailsWhen-
	// RegistrationTimesOut): derselbe ctx budgetiert hier sowohl die
	// Node-Registrierung (muss zuerst erfolgreich durchlaufen, sonst
	// testet dieser Fall nur den bereits anderswo abgedeckten
	// Registrierungs-Timeout) als auch den anschließenden Crosspoint-Wait.
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 300 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	methods := &fakeMethodInvoker{} // inputs bleibt leer: "send-cam1" erscheint nie
	svc := newTestService(newFakeStore(), nodes, g, l)
	svc.methods = methods

	def := Definition{
		Roles: []Role{
			{Name: "cam1", NodeType: "omp-source"},
			{Name: "mix", NodeType: "omp-video-mixer-me"},
		},
		Connections: []Connection{{FromRole: "cam1", ToRole: "mix"}},
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

	camInstance, mixInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-video-mixer-me")
	nodes.add(registry.NodeView{ID: "node-cam1", InstanceID: camInstance, Senders: []registry.SenderView{{ID: "send-cam1"}}})
	nodes.add(registry.NodeView{ID: "node-mix", InstanceID: mixInstance, APIBaseURL: "http://node-mix:9360"})

	failed := waitForStatus(t, svc, wf.ID, StatusFailed)
	if failed.Error == "" {
		t.Fatalf("Error = %q, want a non-empty explanation", failed.Error)
	}

	methods.mu.Lock()
	defer methods.mu.Unlock()
	if len(methods.calls) != 0 {
		t.Fatalf("method invoke calls = %+v, want 0 (must not take() before the input is confirmed discovered)", methods.calls)
	}
}

// TestStartFailsWhenTargetHasNoReceiverAndNoCrosspointMapping deckt den
// Fehlerfall ab: eine Zielrolle ohne Receiver und ohne bekannte
// Crosspoint-Methode (z. B. omp-multiviewer) darf nicht still
// übersprungen werden.
func TestStartFailsWhenTargetHasNoReceiverAndNoCrosspointMapping(t *testing.T) {
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
			{Name: "mv", NodeType: "omp-multiviewer"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "mv"}},
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

	srcInstance, mvInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-multiviewer")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-1"}}})
	nodes.add(registry.NodeView{ID: "node-mv", InstanceID: mvInstance})

	failed := waitForStatus(t, svc, wf.ID, StatusFailed)
	if failed.Error == "" {
		t.Fatalf("Error = %q, want a non-empty explanation", failed.Error)
	}
}

// TestCreateRejectsMultipleConnectionsToSameCrosspointTarget: zwei
// Kameras, die beide direkt auf denselben Bildmischer verkabelt werden
// sollen, sind zum Startzeitpunkt unauflösbar (welcher Sender gewinnt?)
// — muss schon bei Create() abgelehnt werden, nicht erst beim Start.
func TestCreateRejectsMultipleConnectionsToSameCrosspointTarget(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles: []Role{
			{Name: "cam1", NodeType: "omp-source"},
			{Name: "cam2", NodeType: "omp-source"},
			{Name: "mix", NodeType: "omp-video-mixer-me"},
		},
		Connections: []Connection{
			{FromRole: "cam1", ToRole: "mix"},
			{FromRole: "cam2", ToRole: "mix"},
		},
	}
	_, err := svc.Create("regie", def)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

// TestStartPassesResolutionSettingsAsExtraEnv ist die Kern-Verifikation
// für Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c, 2026-07-17): eine
// gesetzte Workflow-Auflösung landet als OMP_WIDTH/OMP_HEIGHT-extraEnv
// bei jedem Rollen-Start. Ein Workflow OHNE Settings darf dagegen kein
// extraEnv erzeugen (0 = Node behält ihren eigenen Default).
func TestStartPassesResolutionSettingsAsExtraEnv(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 200 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles:    []Role{{Name: "src", NodeType: "omp-source"}},
		Settings: Settings{ProgramWidth: 1280, ProgramHeight: 720},
	}
	wf, err := svc.Create("hires", def)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		_, ok := l.lastExtraEnv["omp-source"]
		l.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	l.mu.Lock()
	env := l.lastExtraEnv["omp-source"]
	l.mu.Unlock()
	if env["OMP_WIDTH"] != "1280" || env["OMP_HEIGHT"] != "720" {
		t.Fatalf("extraEnv = %+v, want OMP_WIDTH=1280 OMP_HEIGHT=720", env)
	}

	// Zweiter Workflow ohne Settings: kein extraEnv-Eintrag für die Auflösung.
	def2 := Definition{Roles: []Role{{Name: "src", NodeType: "omp-viewer"}}}
	wf2, err := svc.Create("no-settings", def2)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf2.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		_, ok := l.lastExtraEnv["omp-viewer"]
		l.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	l.mu.Lock()
	env2 := l.lastExtraEnv["omp-viewer"]
	l.mu.Unlock()
	if _, ok := env2["OMP_WIDTH"]; ok {
		t.Errorf("extraEnv = %+v, want no OMP_WIDTH for a workflow without Settings", env2)
	}
	if _, ok := env2["OMP_HEIGHT"]; ok {
		t.Errorf("extraEnv = %+v, want no OMP_HEIGHT for a workflow without Settings", env2)
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

	if err := svc.Stop(context.Background(), wf.ID, false); err != nil {
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

	if err := svc.Stop(context.Background(), wf.ID, false); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Stop() error = %v, want ErrNotRunning", err)
	}
}

// --- D7 Teil 2: Stop-Sicherheitsabfrage (confirm_stop) ---

func TestStopRequiresConfirmationWhenConfirmStopSet(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{
		Roles:    []Role{{Name: "src", NodeType: "omp-source"}},
		Settings: Settings{ConfirmStop: true},
	}
	wf, _ := svc.Create("wf", def)
	started := wf
	started.Status = StatusStarted
	store.Put(started)

	if err := svc.Stop(context.Background(), wf.ID, false); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("Stop(confirm=false) error = %v, want ErrConfirmationRequired", err)
	}

	// Nach der abgelehnten Anfrage muss der Workflow weiterhin "started"
	// sein (kein Teilfortschritt Richtung "stopping").
	stillStarted, _ := svc.Get(wf.ID)
	if stillStarted.Status != StatusStarted {
		t.Fatalf("Status after rejected Stop() = %q, want unchanged %q", stillStarted.Status, StatusStarted)
	}

	if err := svc.Stop(context.Background(), wf.ID, true); err != nil {
		t.Fatalf("Stop(confirm=true) error = %v, want nil", err)
	}
}

func TestStopWithoutConfirmStopSettingIgnoresConfirmFlag(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}})
	started := wf
	started.Status = StatusStarted
	store.Put(started)

	// Kein confirm_stop gesetzt: confirm=false (unverändertes
	// Vor-D7-Teil-2-Verhalten) darf nicht plötzlich abgelehnt werden.
	if err := svc.Stop(context.Background(), wf.ID, false); err != nil {
		t.Fatalf("Stop(confirm=false) error = %v, want nil (ConfirmStop not set)", err)
	}
}

// --- D7 Teil 2: Ressourcen-Vorprüfung als Start-Vorbedingung ---

type fakeResourcePrecheck struct {
	deniedHosts map[string]string // hostID -> Ablehnungsgrund
}

func (f *fakeResourcePrecheck) CheckHost(hostID string) (string, bool) {
	if reason, denied := f.deniedHosts[hostID]; denied {
		return reason, false
	}
	return "", true
}

func TestStartRejectsWhenTargetHostResourcesUnavailable(t *testing.T) {
	store := newFakeStore()
	l := &fakeLauncher{}
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, l)
	svc.resources = &fakeResourcePrecheck{deniedHosts: map[string]string{"host-1": "CPU 95% über dem Schwellwert"}}

	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source", HostID: "host-1"}}}
	wf, _ := svc.Create("wf", def)

	err := svc.Start(context.Background(), wf.ID)
	if !errors.Is(err, ErrResourcesUnavailable) {
		t.Fatalf("Start() error = %v, want ErrResourcesUnavailable", err)
	}

	// Kein Teil-Start: der Launcher darf gar nicht erst aufgerufen worden
	// sein, und der Workflow muss "stopped" bleiben (nie "starting").
	l.mu.Lock()
	startedCount := len(l.started)
	l.mu.Unlock()
	if startedCount != 0 {
		t.Fatalf("launcher.Start() calls = %d, want 0 (no partial start)", startedCount)
	}
	after, _ := svc.Get(wf.ID)
	if after.Status != StatusStopped {
		t.Fatalf("Status after rejected Start() = %q, want unchanged %q", after.Status, StatusStopped)
	}
}

func TestStartIgnoresResourceCheckForLocalRoles(t *testing.T) {
	store := newFakeStore()
	l := &fakeLauncher{}
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, l)
	// Alle Hosts abgelehnt — betrifft aber nur Rollen mit gesetzter
	// HostID; eine lokale Rolle (HostID leer) hat dafür heute keine
	// Telemetrie-Grundlage (s. checkResources-Doku) und darf nicht
	// blockiert werden.
	svc.resources = &fakeResourcePrecheck{deniedHosts: map[string]string{"": "sollte nie geprüft werden"}}

	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}
	wf, _ := svc.Create("wf", def)

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v, want nil (local role must not be resource-checked)", err)
	}
}

// --- D7 Teil 2: Schedule-Validierung ---

func TestCreateRejectsScheduleWithUnknownKind(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: "monthly", Action: ScheduleActionStart}},
	}
	if _, err := svc.Create("wf", def); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsOnceScheduleWithoutAt(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart}},
	}
	if _, err := svc.Create("wf", def); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsDailyScheduleWithInvalidTimeOfDay(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "25:00"}},
	}
	if _, err := svc.Create("wf", def); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsWeeklyScheduleWithoutWeekday(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleWeekly, Action: ScheduleActionStart, TimeOfDay: "08:00"}},
	}
	if _, err := svc.Create("wf", def); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateAcceptsValidSchedules(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	at := time.Now().Add(time.Hour)
	weekday := 3
	def := Definition{
		Roles: []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{
			{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at},
			{ID: "s2", Kind: ScheduleDaily, Action: ScheduleActionStop, TimeOfDay: "22:00"},
			{ID: "s3", Kind: ScheduleWeekly, Action: ScheduleActionStart, TimeOfDay: "08:00", Weekday: &weekday},
		},
	}
	if _, err := svc.Create("wf", def); err != nil {
		t.Fatalf("Create() error = %v, want nil", err)
	}
}

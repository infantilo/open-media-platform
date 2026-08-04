package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// fakeEventPublisher ist ein Test-Double für EventPublisher, das nur die
// Typen der empfangenen Events sammelt (gleiches Muster wie
// graph_test.go/audit_test.go).
type fakeEventPublisher struct{ types []string }

func (f *fakeEventPublisher) Broadcast(e sse.Event) { f.types = append(f.types, e.Type) }

type fakeStore struct {
	mu         sync.Mutex
	wfs        map[string]Workflow
	roleStates fakeRoleStateStore
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

// roleStates spiegelt die separate role_state-JSONB-Spalte (Migration
// 0011) — eigene Map statt eines Felds auf Workflow, da
// Store.SetRoleState bewusst nicht über das Workflow-Objekt selbst
// geht (s. store.go).
type fakeRoleStateStore = map[string]map[string]json.RawMessage

func (f *fakeStore) SetRoleState(id, role string, state json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.roleStates == nil {
		f.roleStates = fakeRoleStateStore{}
	}
	if f.roleStates[id] == nil {
		f.roleStates[id] = map[string]json.RawMessage{}
	}
	f.roleStates[id][role] = state
	return nil
}

func (f *fakeStore) GetRoleState(id string) (map[string]json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]json.RawMessage{}
	for role, state := range f.roleStates[id] {
		out[role] = state
	}
	return out, nil
}

func (f *fakeStore) ClearRoleState(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.roleStates, id)
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
	// catalog (Kapitel 12 Teil 3, §12.3d) — von Import() gegen
	// Rollen-nodeType-Werte geprüft.
	catalog []launcher.CatalogEntry
	// lastLabel (Nutzerwunsch 2026-07-28) — das customLabel des zuletzt
	// beobachteten StartLabeled()-Aufrufs, ein Eintrag pro nodeType.
	lastLabel map[string]string
}

func (f *fakeLauncher) Catalog() []launcher.CatalogEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.catalog
}

func (f *fakeLauncher) Start(nodeType, version, hostID string, extraEnv map[string]string) (launcher.Instance, error) {
	return f.StartLabeled(nodeType, version, hostID, "", extraEnv)
}

func (f *fakeLauncher) StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error) {
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
	if f.lastLabel == nil {
		f.lastLabel = map[string]string{}
	}
	f.lastLabel[nodeType] = customLabel
	label := customLabel
	if label == "" {
		label = nodeType
	}
	return launcher.Instance{ID: id, Type: nodeType, Label: label, HostID: hostID}, nil
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

// fakeAuthzBinder ist ein Test-Double für AuthzBinder (ARCHITECTURE.md
// §24.1, UMSETZUNG.md C16).
type fakeAuthzBinder struct {
	mu      sync.Mutex
	created []authz.Binding
	err     error
}

func (f *fakeAuthzBinder) Create(subject, workflowID, nodeID string, verb authz.Verb) (authz.Binding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return authz.Binding{}, f.err
	}
	b := authz.Binding{Subject: subject, WorkflowID: workflowID, NodeID: nodeID, Verb: verb}
	f.created = append(f.created, b)
	return b, nil
}

func (f *fakeAuthzBinder) snapshot() []authz.Binding {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]authz.Binding, len(f.created))
	copy(out, f.created)
	return out
}

// LoadByWorkflow/DeleteByWorkflow (Nutzerwunsch 2026-07-28) — minimale,
// aber echte In-Memory-Semantik statt No-Ops, damit Export/Delete-Tests
// tatsächlich etwas prüfen können.
func (f *fakeAuthzBinder) LoadByWorkflow(workflowID string) ([]authz.Binding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []authz.Binding
	for _, b := range f.created {
		if b.WorkflowID == workflowID {
			out = append(out, b)
		}
	}
	return out, nil
}

func (f *fakeAuthzBinder) DeleteByWorkflow(workflowID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.created[:0]
	for _, b := range f.created {
		if b.WorkflowID != workflowID {
			kept = append(kept, b)
		}
	}
	f.created = kept
	return nil
}

// newTestService baut einen Service direkt per Struct-Literal statt über
// NewService (das eine konkrete *Store, keine Fakes, erwartet) — gleiches
// Muster wie internal/snapshots.newTestService.
func newTestService(store workflowStore, nodes NodeLister, g GraphService, l Launcher) *Service {
	return &Service{store: store, nodes: nodes, graph: g, launcher: l, migrations: newMigrationState()}
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
	_, err := svc.Create("empty", Definition{}, nil)
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
	_, err := svc.Create("bad", def, nil)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateAndListRoundTrip(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}
	wf, err := svc.Create("my workflow", def, nil)
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

// Nutzerwunsch (2026-07-21): "Als Workflow speichern" aus einer bereits
// laufenden Gruppe soll den Workflow nicht fälschlich als "stopped"
// anzeigen. Drei Fälle: vollständige Zuordnung -> sofort "started" mit
// genau dieser Runtime; unvollständige/unbekannte Zuordnung -> abgelehnt
// statt eines widersprüchlichen Zwischenzustands.
func TestCreateWithFullAdoptionStartsImmediately(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{Roles: []Role{
		{Name: "src", NodeType: "omp-source"},
		{Name: "mixer", NodeType: "omp-video-mixer-me"},
	}}
	adopt := map[string]RoleRuntime{
		"src":   {InstanceID: "src-instance-1", NodeID: "src-node-1"},
		"mixer": {InstanceID: "mixer-instance-1", NodeID: "mixer-node-1"},
	}
	wf, err := svc.Create("adopted", def, adopt)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if wf.Status != StatusStarted {
		t.Errorf("Status = %q, want started", wf.Status)
	}
	if wf.Runtime["src"].NodeID != "src-node-1" || wf.Runtime["mixer"].InstanceID != "mixer-instance-1" {
		t.Errorf("Runtime = %+v, want adopted entries preserved", wf.Runtime)
	}

	stored, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if stored.Status != StatusStarted || len(stored.Runtime) != 2 {
		t.Errorf("stored workflow = %+v, want persisted started status + full runtime", stored)
	}
}

func TestCreateRejectsPartialAdoption(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{Roles: []Role{
		{Name: "src", NodeType: "omp-source"},
		{Name: "mixer", NodeType: "omp-video-mixer-me"},
	}}
	// Nur "src" abgedeckt, "mixer" fehlt.
	adopt := map[string]RoleRuntime{"src": {InstanceID: "src-instance-1", NodeID: "src-node-1"}}
	_, err := svc.Create("partial", def, adopt)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsAdoptionForUnknownRole(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}
	adopt := map[string]RoleRuntime{"does-not-exist": {InstanceID: "x", NodeID: "y"}}
	_, err := svc.Create("bad-adopt", def, adopt)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestDeleteRequiresStopped(t *testing.T) {
	store := newFakeStore()
	svc := &Service{store: store}
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

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

	if _, err := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil); err != nil {
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
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

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
	wf, err := svc.Create("regie", def, nil)
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

// TestStartProvisionsServiceBindingForControlPlaneRole deckt
// ARCHITECTURE.md §24.1 / UMSETZUNG.md C16 ab: eine Rolle mit
// NodeType "omp-playout-automation" bekommt bei Start() automatisch
// eine Workflow-gescopte VerbOperate-Bindung auf ihre eigene
// Instanz-ID — eine reine Medien-Rolle (omp-source) dagegen nicht.
func TestStartProvisionsServiceBindingForControlPlaneRole(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	az := &fakeAuthzBinder{}
	svc := &Service{store: newFakeStore(), nodes: nodes, graph: g, launcher: l, authz: az}

	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"},
			{Name: "automation", NodeType: "omp-playout-automation"},
		},
	}
	wf, err := svc.Create("regie", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(az.snapshot()) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	bindings := az.snapshot()
	if len(bindings) != 1 {
		t.Fatalf("bindings created = %+v, want exactly 1 (only the control-plane role)", bindings)
	}
	automationInstanceID := l.instanceIDFor("omp-playout-automation")
	b := bindings[0]
	if b.Subject != automationInstanceID || b.WorkflowID != wf.ID || b.NodeID != authz.AnyNode || b.Verb != authz.VerbOperate {
		t.Fatalf("binding = %+v, want {Subject:%s WorkflowID:%s NodeID:%s Verb:%s}",
			b, automationInstanceID, wf.ID, authz.AnyNode, authz.VerbOperate)
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
	wf, err := svc.Create("regie", def, nil)
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
	wf, err := svc.Create("regie", def, nil)
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
	wf, err := svc.Create("regie", def, nil)
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
	wf, err := svc.Create("regie", def, nil)
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
	_, err := svc.Create("regie", def, nil)
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
	wf, err := svc.Create("hires", def, nil)
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
	wf2, err := svc.Create("no-settings", def2, nil)
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

// TestCreateRejectsUnknownFormat deckt den Nutzerwunsch 2026-07-28 ab
// (einstellbares Standard-Format je Rolle): ein Tippfehler/unbekannter
// Preset-Name wird sofort bei Create() abgelehnt, nicht erst beim Start
// stillschweigend ignoriert.
func TestCreateRejectsUnknownFormat(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source", Format: "4k-does-not-exist"}}}
	if _, err := svc.Create("regie", def, nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

// TestStartAppliesPerRoleFormatIndependently deckt den Nutzerwunsch
// 2026-07-28 ab: zwei Rollen im selben Workflow mit unterschiedlichem
// Role.Format bekommen unterschiedliche OMP_WIDTH/OMP_HEIGHT/
// OMP_FRAMERATE_NUM/OMP_FRAMERATE_DEN — die Rollen dürfen sich nicht
// gegenseitig beeinflussen (roleEnv ist eine eigene Map pro Rolle, s.
// runStart-Doku), und eine dritte Rolle ohne Format bleibt unverändert
// (Node-eigener Default, kein OMP_WIDTH gesetzt).
func TestStartAppliesPerRoleFormatIndependently(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 200 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, g, l)

	def := Definition{Roles: []Role{
		{Name: "cheap", NodeType: "omp-source", Format: "480p25"},
		{Name: "flagship", NodeType: "omp-viewer", Format: "1080p50"},
	}}
	wf, err := svc.Create("mixed-formats", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		_, ok1 := l.lastExtraEnv["omp-source"]
		_, ok2 := l.lastExtraEnv["omp-viewer"]
		l.mu.Unlock()
		if ok1 && ok2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	l.mu.Lock()
	cheapEnv := l.lastExtraEnv["omp-source"]
	flagshipEnv := l.lastExtraEnv["omp-viewer"]
	l.mu.Unlock()

	if cheapEnv["OMP_WIDTH"] != "848" || cheapEnv["OMP_HEIGHT"] != "480" || cheapEnv["OMP_FRAMERATE_NUM"] != "25" {
		t.Fatalf("cheap role extraEnv = %+v, want 480p25", cheapEnv)
	}
	if flagshipEnv["OMP_WIDTH"] != "1920" || flagshipEnv["OMP_HEIGHT"] != "1080" || flagshipEnv["OMP_FRAMERATE_NUM"] != "50" {
		t.Fatalf("flagship role extraEnv = %+v, want 1080p50", flagshipEnv)
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
	wf, err := svc.Create("regie", def, nil)
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

// TestRestartRoleAppliesNewFormatAndReconnects (Nutzerwunsch 2026-07-29:
// "scaler hat immer noch keine Auswahl im Property-Editor für Format")
// deckt den gewählten Ansatz ab: nur EINE Rolle eines laufenden
// Workflows neu starten, mit neuem role.Format, ohne den Rest zu
// stoppen — Format landet in der Definition, alte Instanz wird
// gestoppt, neue mit den passenden OMP_WIDTH/HEIGHT/FRAMERATE-Envs
// gestartet, betroffene Connections werden neu angewendet.
func TestRestartRoleAppliesNewFormatAndReconnects(t *testing.T) {
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
			{Name: "scaler", NodeType: "omp-scaler"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "scaler"}},
	}
	wf, err := svc.Create("regie", def, nil)
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
	srcInstance, scalerInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-scaler")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-1", Format: formatVideo}}})
	nodes.add(registry.NodeView{ID: "node-scaler", InstanceID: scalerInstance, Receivers: []registry.ReceiverView{{ID: "recv-1", Format: formatVideo}}})
	waitForStatus(t, svc, wf.ID, StatusStarted)

	if err := svc.RestartRole(context.Background(), wf.ID, "scaler", "1080p50"); err != nil {
		t.Fatalf("RestartRole() error = %v", err)
	}

	// role.Format persistiert sofort, synchron (nicht erst nach dem
	// Hintergrund-Neustart) — Nutzer soll die Auswahl sofort im
	// Property-Panel bestätigt sehen.
	wfAfterCall, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	gotFormat := ""
	for _, r := range wfAfterCall.Definition.Roles {
		if r.Name == "scaler" {
			gotFormat = r.Format
		}
	}
	if gotFormat != "1080p50" {
		t.Fatalf("role.Format = %q, want 1080p50 immediately after RestartRole()", gotFormat)
	}

	// Neue Registrierung für die neue Instanz simulieren (anderer Sender
	// als zuvor, wie bei einem echten Rebuild mit neuer Auflösung).
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		stoppedOld := len(l.stopped) > 0 && l.stopped[0] == scalerInstance
		l.mu.Unlock()
		if stoppedOld {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	newScalerInstance := l.instanceIDFor("omp-scaler")
	if newScalerInstance == scalerInstance {
		t.Fatalf("expected a new omp-scaler instance to have been started, still see the old one %q", scalerInstance)
	}
	nodes.add(registry.NodeView{ID: "node-scaler-2", InstanceID: newScalerInstance, Receivers: []registry.ReceiverView{{ID: "recv-2", Format: formatVideo}}})

	deadline = time.Now().Add(2 * time.Second)
	var wfAfter Workflow
	for time.Now().Before(deadline) {
		wfAfter, err = svc.Get(wf.ID)
		if err != nil {
			t.Fatalf("Get() error = %v", err)
		}
		if wfAfter.Runtime["scaler"].NodeID == "node-scaler-2" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if wfAfter.Runtime["scaler"].NodeID != "node-scaler-2" {
		t.Fatalf("Runtime[\"scaler\"].NodeID = %q, want it updated to node-scaler-2 after the role restart", wfAfter.Runtime["scaler"].NodeID)
	}

	l.mu.Lock()
	env := l.lastExtraEnv["omp-scaler"]
	l.mu.Unlock()
	if env["OMP_WIDTH"] != "1920" || env["OMP_HEIGHT"] != "1080" || env["OMP_FRAMERATE_NUM"] != "50" {
		t.Errorf("new instance extraEnv = %+v, want 1920x1080@50 from the 1080p50 preset", env)
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("connect calls after role restart = %+v, want a second call reconnecting to the new receiver", g.calls)
	}
	if g.calls[1].fromSender != "send-1" || g.calls[1].toReceiver != "recv-2" {
		t.Errorf("second connect call = %+v, want send-1 -> recv-2", g.calls[1])
	}
}

func TestRestartRoleRejectsUnknownFormat(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{Roles: []Role{{Name: "scaler", NodeType: "omp-scaler"}}}
	wf, _ := svc.Create("wf", def, nil)
	started := wf
	started.Status = StatusStarted
	started.Runtime = map[string]RoleRuntime{"scaler": {InstanceID: "inst-1", NodeID: "node-1"}}

	store := svc.store.(*fakeStore)
	store.Put(started)

	err := svc.RestartRole(context.Background(), wf.ID, "scaler", "not-a-real-format")
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("RestartRole() error = %v, want ErrValidation", err)
	}
}

func TestRestartRoleRequiresStartedWorkflow(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{Roles: []Role{{Name: "scaler", NodeType: "omp-scaler"}}}
	wf, _ := svc.Create("wf", def, nil) // stays "stopped"

	err := svc.RestartRole(context.Background(), wf.ID, "scaler", "1080p50")
	if !errors.Is(err, ErrNotRunning) {
		t.Fatalf("RestartRole() error = %v, want ErrNotRunning", err)
	}
}

func TestStartFailsWhenRegistrationTimesOut(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 100 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

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
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

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
	}}, nil)
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
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

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
	wf, _ := svc.Create("wf", def, nil)
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
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	started := wf
	started.Status = StatusStarted
	store.Put(started)

	// Kein confirm_stop gesetzt: confirm=false (unverändertes
	// Vor-D7-Teil-2-Verhalten) darf nicht plötzlich abgelehnt werden.
	if err := svc.Stop(context.Background(), wf.ID, false); err != nil {
		t.Fatalf("Stop(confirm=false) error = %v, want nil (ConfirmStop not set)", err)
	}
}

// --- Nachtrag 99: Auto-Placement ersetzt die harte D7-Teil-2-Vorprüfung ---

// fakeResourcePrecheck simuliert *placement.Engine für service_test.go
// (keine echte Engine mit Postgres-Profile-Store nötig, gleiches Muster
// wie fakeLauncher/fakeNodeLister/fakeGraph). altHostID ist der Host, auf
// den SelectHost ausweicht, wenn PreferredHostID in deniedHosts steht —
// ein simples Test-Double, keine echte Kandidatenliste wie die reale
// Engine (die hat eigene SelectHost-Tests in placement_test.go).
type fakeResourcePrecheck struct {
	deniedHosts map[string]string // hostID -> Ablehnungsgrund
	altHostID   string
}

func (f *fakeResourcePrecheck) CheckHost(hostID, nodeType string) (string, bool) {
	if reason, denied := f.deniedHosts[hostID]; denied {
		return reason, false
	}
	return "", true
}

func (f *fakeResourcePrecheck) SelectHost(req placement.PlacementRequest, _ placement.Occupancy) placement.PlacementResult {
	if reason, denied := f.deniedHosts[req.PreferredHostID]; denied && req.PreferredHostID != "" {
		return placement.PlacementResult{HostID: f.altHostID, Reason: "ausgewichen: " + reason}
	}
	return placement.PlacementResult{HostID: req.PreferredHostID}
}

func (f *fakeResourcePrecheck) ProjectedLoad(nodeType, hostID string) profiles.Snapshot {
	return profiles.Snapshot{}
}

func TestStartFallsBackToAlternativeHostWhenPreferredIsOverloaded(t *testing.T) {
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	svc.resources = &fakeResourcePrecheck{
		deniedHosts: map[string]string{"host-1": "CPU 95% über dem Schwellwert"},
		altHostID:   "host-2",
	}

	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source", HostID: "host-1"}}}
	wf, _ := svc.Create("wf", def, nil)

	// Nachtrag 99: Start() schlägt nicht mehr wegen Ressourcenüberlastung
	// fehl — es findet immer einen Host (hier: den simulierten Ausweich-
	// host-2 statt des überlasteten host-1).
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v, want nil (must succeed by placing on an alternative host)", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		startedCount := len(l.started)
		l.mu.Unlock()
		if startedCount == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	srcInstance := l.instanceIDFor("omp-source")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance})

	started := waitForStatus(t, svc, wf.ID, StatusStarted)
	if started.Runtime["src"].HostID != "host-2" {
		t.Fatalf("Runtime[src].HostID = %q, want %q (resolved via SelectHost fallback, not the overloaded preference)", started.Runtime["src"].HostID, "host-2")
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
	wf, _ := svc.Create("wf", def, nil)

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
	if _, err := svc.Create("wf", def, nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsOnceScheduleWithoutAt(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleOnce, Action: ScheduleActionStart}},
	}
	if _, err := svc.Create("wf", def, nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsDailyScheduleWithInvalidTimeOfDay(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "25:00"}},
	}
	if _, err := svc.Create("wf", def, nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create() error = %v, want ErrValidation", err)
	}
}

func TestCreateRejectsWeeklyScheduleWithoutWeekday(t *testing.T) {
	svc := &Service{store: newFakeStore()}
	def := Definition{
		Roles:     []Role{{Name: "src", NodeType: "omp-source"}},
		Schedules: []Schedule{{ID: "s1", Kind: ScheduleWeekly, Action: ScheduleActionStart, TimeOfDay: "08:00"}},
	}
	if _, err := svc.Create("wf", def, nil); !errors.Is(err, ErrValidation) {
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
	if _, err := svc.Create("wf", def, nil); err != nil {
		t.Fatalf("Create() error = %v, want nil", err)
	}
}

// --- Kapitel 12 Teil 3: Pause/Resume ---

func TestPauseStopsRunningRolesAndLandsInPaused(t *testing.T) {
	store := newFakeStore()
	l := &fakeLauncher{}
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, l)

	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	running := wf
	running.Status = StatusStarted
	running.Runtime = map[string]RoleRuntime{"src": {InstanceID: "inst-src", NodeID: "node-src"}}
	store.Put(running)

	if err := svc.Pause(context.Background(), wf.ID, false); err != nil {
		t.Fatalf("Pause() error = %v", err)
	}

	paused := waitForStatus(t, svc, wf.ID, StatusPaused)
	if len(paused.Runtime) != 0 {
		t.Errorf("Runtime = %+v, want empty after pause (same resource effect as stop)", paused.Runtime)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.stopped) != 1 || l.stopped[0] != "inst-src" {
		t.Errorf("launcher.Stop() calls = %+v, want exactly one for inst-src", l.stopped)
	}
}

func TestPauseRequiresRunning(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)

	if err := svc.Pause(context.Background(), wf.ID, false); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Pause() error = %v, want ErrNotRunning", err)
	}
}

func TestPauseRequiresConfirmationWhenConfirmStopSet(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{
		Roles:    []Role{{Name: "src", NodeType: "omp-source"}},
		Settings: Settings{ConfirmStop: true},
	}
	wf, _ := svc.Create("wf", def, nil)
	started := wf
	started.Status = StatusStarted
	store.Put(started)

	if err := svc.Pause(context.Background(), wf.ID, false); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("Pause(confirm=false) error = %v, want ErrConfirmationRequired", err)
	}
	if err := svc.Pause(context.Background(), wf.ID, true); err != nil {
		t.Fatalf("Pause(confirm=true) error = %v, want nil", err)
	}
}

func TestStartResumesFromPaused(t *testing.T) {
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	store := newFakeStore()
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(store, nodes, &fakeGraph{}, l)

	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	paused := wf
	paused.Status = StatusPaused
	store.Put(paused)

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() from paused error = %v, want nil (Resume = normaler Start)", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		started := len(l.started) > 0
		l.mu.Unlock()
		if started {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	l.mu.Lock()
	startCount := len(l.started)
	l.mu.Unlock()
	if startCount != 1 {
		t.Fatalf("launcher.Start() calls = %d, want exactly 1 (fresh provisioning on resume)", startCount)
	}
}

func TestDeleteAllowsPaused(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	paused := wf
	paused.Status = StatusPaused
	store.Put(paused)

	if err := svc.Delete(wf.ID); err != nil {
		t.Fatalf("Delete() from paused error = %v, want nil", err)
	}
}

func TestUpdateAllowsPaused(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	paused := wf
	paused.Status = StatusPaused
	store.Put(paused)

	if _, err := svc.Update(wf.ID, "renamed", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}); err != nil {
		t.Fatalf("Update() from paused error = %v, want nil", err)
	}
}

// Bugfix 2026-07-26 (Nutzerwunsch: einen laufenden Workflow "wie eine
// Gruppe" betreten und den aktuellen Live-Stand als neue Definition
// speichern) — Update() akzeptiert jetzt auch "started", s. dortige
// Doku für die Sicherheitsbegründung.
func TestUpdateAllowsStarted(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	started := wf
	started.Status = StatusStarted
	store.Put(started)

	if _, err := svc.Update(wf.ID, "renamed", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}); err != nil {
		t.Fatalf("Update() from started error = %v, want nil", err)
	}
}

// --- Kapitel 12 Teil 3: Export/Import ---

func TestExportRoundTripsDefinition(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{
		Roles:       []Role{{Name: "src", NodeType: "omp-source"}, {Name: "view", NodeType: "omp-viewer"}},
		Connections: []Connection{{FromRole: "src", ToRole: "view"}},
	}
	wf, err := svc.Create("Regieplatz 1", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	exported, err := svc.Export(wf.ID, false)
	if err != nil {
		t.Fatalf("Export() error = %v", err)
	}
	if exported.Name != "Regieplatz 1" || len(exported.Definition.Roles) != 2 || len(exported.Definition.Connections) != 1 {
		t.Fatalf("Export() = %+v, want roundtripped definition", exported)
	}
	if exported.Version != exportVersion {
		t.Fatalf("Export().Version = %d, want %d", exported.Version, exportVersion)
	}
}

func TestExportUnknownWorkflowReturnsNotFound(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	if _, err := svc.Export("does-not-exist", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Export() error = %v, want ErrNotFound", err)
	}
}

// TestExportOmitsBindingsByDefault deckt den in ExportedWorkflow.Bindings
// dokumentierten Grundsatz ab ("ohne Nutzerdaten mitzuschleppen"): ohne
// includeBindings=true bleibt das Feld leer, selbst wenn Bindungen für
// den Workflow existieren.
func TestExportOmitsBindingsByDefault(t *testing.T) {
	az := &fakeAuthzBinder{}
	svc := &Service{store: newFakeStore(), nodes: &fakeNodeLister{}, graph: &fakeGraph{}, launcher: &fakeLauncher{}, authz: az}
	wf, err := svc.Create("Regieplatz 1", Definition{Roles: []Role{{Name: "mixer", NodeType: "omp-video-mixer-me"}}}, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := az.Create("bildmeister", wf.ID, "mixer", authz.VerbOperate); err != nil {
		t.Fatalf("az.Create() error = %v", err)
	}

	exported, err := svc.Export(wf.ID, false)
	if err != nil {
		t.Fatalf("Export() error = %v", err)
	}
	if len(exported.Bindings) != 0 {
		t.Fatalf("Export(includeBindings=false).Bindings = %+v, want empty", exported.Bindings)
	}

	exportedWithBindings, err := svc.Export(wf.ID, true)
	if err != nil {
		t.Fatalf("Export(includeBindings=true) error = %v", err)
	}
	if len(exportedWithBindings.Bindings) != 1 || exportedWithBindings.Bindings[0].Subject != "bildmeister" || exportedWithBindings.Bindings[0].Role != "mixer" {
		t.Fatalf("Export(includeBindings=true).Bindings = %+v, want one bildmeister/mixer binding", exportedWithBindings.Bindings)
	}
}

// TestDeleteCascadesRoleBindings deckt den Nutzerwunsch 2026-07-28 ab:
// ein endgültig gelöschter Workflow darf keine verwaisten Bindungen
// zurücklassen.
func TestDeleteCascadesRoleBindings(t *testing.T) {
	az := &fakeAuthzBinder{}
	svc := &Service{store: newFakeStore(), nodes: &fakeNodeLister{}, graph: &fakeGraph{}, launcher: &fakeLauncher{}, authz: az}
	wf, err := svc.Create("Regieplatz 1", Definition{Roles: []Role{{Name: "mixer", NodeType: "omp-video-mixer-me"}}}, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := az.Create("bildmeister", wf.ID, "mixer", authz.VerbOperate); err != nil {
		t.Fatalf("az.Create() error = %v", err)
	}
	if _, err := az.Create("other-user", "some-other-workflow", authz.AnyNode, authz.VerbAdmin); err != nil {
		t.Fatalf("az.Create() error = %v", err)
	}

	if err := svc.Delete(wf.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	remaining, err := az.LoadByWorkflow(wf.ID)
	if err != nil {
		t.Fatalf("LoadByWorkflow() error = %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("LoadByWorkflow(%s) after Delete = %+v, want empty", wf.ID, remaining)
	}
	if len(az.snapshot()) != 1 {
		t.Fatalf("unrelated bindings for other workflows = %+v, want exactly the one untouched binding", az.snapshot())
	}
}

// TestImportRestoresBindingsFromExport deckt den Nutzerwunsch
// 2026-07-28 ab: Export(includeBindings=true) → Import stellt dieselben
// Bindungen gegen die neue Workflow-ID wieder her.
func TestImportRestoresBindingsFromExport(t *testing.T) {
	az := &fakeAuthzBinder{}
	l := &fakeLauncher{catalog: []launcher.CatalogEntry{{Type: "omp-video-mixer-me"}}}
	svc := &Service{store: newFakeStore(), nodes: &fakeNodeLister{}, graph: &fakeGraph{}, launcher: l, authz: az}

	wf, err := svc.Create("Regieplatz 1", Definition{Roles: []Role{{Name: "mixer", NodeType: "omp-video-mixer-me"}}}, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := az.Create("bildmeister", wf.ID, "mixer", authz.VerbOperate); err != nil {
		t.Fatalf("az.Create() error = %v", err)
	}
	exported, err := svc.Export(wf.ID, true)
	if err != nil {
		t.Fatalf("Export() error = %v", err)
	}

	if err := svc.Delete(wf.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	reimported, err := svc.Import(exported)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if reimported.ID == wf.ID {
		t.Fatalf("Import() reused the deleted workflow's id, want a fresh one")
	}

	restored, err := az.LoadByWorkflow(reimported.ID)
	if err != nil {
		t.Fatalf("LoadByWorkflow() error = %v", err)
	}
	if len(restored) != 1 || restored[0].Subject != "bildmeister" || restored[0].NodeID != "mixer" || restored[0].Verb != authz.VerbOperate {
		t.Fatalf("LoadByWorkflow(%s) after Import = %+v, want the restored bildmeister/mixer binding", reimported.ID, restored)
	}
}

func TestImportRejectsUnknownNodeType(t *testing.T) {
	l := &fakeLauncher{catalog: []launcher.CatalogEntry{{Type: "omp-source"}}}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)

	exported := ExportedWorkflow{
		Version: 1,
		Name:    "Imported",
		Definition: Definition{
			Roles: []Role{{Name: "gone", NodeType: "omp-does-not-exist"}},
		},
	}
	if _, err := svc.Import(exported); !errors.Is(err, ErrValidation) {
		t.Fatalf("Import() error = %v, want ErrValidation (unknown catalog type must not create an import torso)", err)
	}
}

func TestImportCreatesStoppedWorkflow(t *testing.T) {
	l := &fakeLauncher{catalog: []launcher.CatalogEntry{{Type: "omp-source"}}}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)

	exported := ExportedWorkflow{
		Version:    1,
		Name:       "Imported Regieplatz",
		Definition: Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}},
	}
	wf, err := svc.Import(exported)
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if wf.Name != "Imported Regieplatz" || wf.Status != StatusStopped || len(wf.Definition.Roles) != 1 {
		t.Fatalf("Import() = %+v, want a new stopped workflow with the imported definition", wf)
	}
}

func TestImportDedupesNameCollisionWithSuffix(t *testing.T) {
	l := &fakeLauncher{catalog: []launcher.CatalogEntry{{Type: "omp-source"}}}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)

	def := Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}
	if _, err := svc.Create("Regieplatz 1", def, nil); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	imported, err := svc.Import(ExportedWorkflow{Version: 1, Name: "Regieplatz 1", Definition: def})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if imported.Name == "Regieplatz 1" {
		t.Fatalf("Import().Name = %q, want a disambiguated suffix (name collision), not the original", imported.Name)
	}
}

// --- Kapitel 12 Teil 4: Workflow-Scope-AuthZ (FindRoleForNode) ---

func TestFindRoleForNodeReturnsWorkflowAndRole(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})

	wf, _ := svc.Create("Regieplatz 1", Definition{Roles: []Role{
		{Name: "mixer", NodeType: "omp-video-mixer-me"},
		{Name: "audio", NodeType: "omp-audio-mixer"},
	}}, nil)
	started := wf
	started.Status = StatusStarted
	started.Runtime = map[string]RoleRuntime{
		"mixer": {InstanceID: "inst-mixer", NodeID: "node-mixer"},
		"audio": {InstanceID: "inst-audio", NodeID: "node-audio"},
	}
	store.Put(started)

	workflowID, workflowName, role, ok := svc.FindRoleForNode("node-mixer")
	if !ok || workflowID != wf.ID || workflowName != "Regieplatz 1" || role != "mixer" {
		t.Fatalf("FindRoleForNode(node-mixer) = (%q, %q, %q, %v), want (%q, %q, %q, true)", workflowID, workflowName, role, ok, wf.ID, "Regieplatz 1", "mixer")
	}
}

func TestFindRoleForNodeNotFoundForUnknownNode(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})

	wf, _ := svc.Create("wf", Definition{Roles: []Role{{Name: "src", NodeType: "omp-source"}}}, nil)
	started := wf
	started.Status = StatusStarted
	started.Runtime = map[string]RoleRuntime{"src": {InstanceID: "inst-src", NodeID: "node-src"}}
	store.Put(started)

	if _, _, _, ok := svc.FindRoleForNode("node-manually-started"); ok {
		t.Fatalf("FindRoleForNode(unrelated node) ok = true, want false")
	}
}

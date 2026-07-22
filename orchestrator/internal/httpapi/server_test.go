package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
	"github.com/infantilo/openmediaplatform/tools/contract-check/checker"
)

// fakeConsoleResolver ist ein einfacher Test-Double für ConsoleResolver
// (UMSETZUNG.md C13) — die meisten bestehenden Handler-Tests interessieren
// sich nicht für Konsolen-Auflösung, deshalb ein leeres Standardergebnis.
type fakeConsoleResolver struct {
	result consoles.Result
	err    error
}

func (f fakeConsoleResolver) Resolve(userID string, nodes []consoles.NodeInfo) (consoles.Result, error) {
	return f.result, f.err
}

// fakeNodeLister ist ein einfacher Test-Double für NodeLister, damit
// Handler-Tests ohne echten Poller/Registry-Client auskommen.
type fakeNodeLister struct {
	nodes        []registry.NodeView
	pollDuration time.Duration
}

func (f fakeNodeLister) List() []registry.NodeView { return f.nodes }

func (f fakeNodeLister) Get(id string) (registry.NodeView, bool) {
	for _, n := range f.nodes {
		if n.ID == id {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (f fakeNodeLister) PollDuration() time.Duration { return f.pollDuration }

// fakeEventSubscriber ist ein Test-Double für EventSubscriber, das einen
// vorgegebenen Kanal statt eines echten sse.Hub liefert.
type fakeEventSubscriber struct {
	ch          chan sse.Event
	clientCount int
	totalDrops  uint64
}

func (f fakeEventSubscriber) Subscribe() (<-chan sse.Event, func()) {
	return f.ch, func() {}
}

// Broadcast ist ein No-Op im Test-Double — s. fakeEventPublisher (in
// host_handlers_test.go) für Tests, die tatsächlich prüfen, was
// gebroadcastet wurde.
func (f fakeEventSubscriber) Broadcast(sse.Event) {}

func (f fakeEventSubscriber) ClientCount() int   { return f.clientCount }
func (f fakeEventSubscriber) TotalDrops() uint64 { return f.totalDrops }

// fakeLayoutStore ist ein einfacher In-Memory-Test-Double für LayoutStore.
type fakeLayoutStore struct{ data map[string]json.RawMessage }

func (f fakeLayoutStore) Get(name string) (json.RawMessage, error) {
	if f.data == nil {
		return nil, layouts.ErrNotFound
	}
	data, ok := f.data[name]
	if !ok {
		return nil, layouts.ErrNotFound
	}
	return data, nil
}

func (f fakeLayoutStore) Put(name string, data json.RawMessage) error {
	if !json.Valid(data) {
		return layouts.ErrInvalidJSON
	}
	if f.data != nil {
		f.data[name] = data
	}
	return nil
}

// fakeGraphService ist ein Test-Double für GraphService, das feste
// Rückgaben liefert und aufgezeichnete Connect/Disconnect-Aufrufe
// nachprüfbar macht.
type fakeGraphService struct {
	g             graph.Graph
	connectErr    error
	disconnectErr error

	connectedFrom, connectedTo string
	disconnectedID             string
}

func (f *fakeGraphService) Graph(ctx context.Context) graph.Graph { return f.g }

func (f *fakeGraphService) Connect(ctx context.Context, fromSender, toReceiver string) error {
	f.connectedFrom, f.connectedTo = fromSender, toReceiver
	return f.connectErr
}

func (f *fakeGraphService) Disconnect(ctx context.Context, receiverID string) error {
	f.disconnectedID = receiverID
	return f.disconnectErr
}

// fakeSnapshotService ist ein Test-Double für SnapshotService.
type fakeSnapshotService struct {
	list        []snapshots.Snapshot
	created     snapshots.Snapshot
	createErr   error
	applyResult snapshots.ApplyResult
	applyErr    error
}

func (f fakeSnapshotService) Create(ctx context.Context, label string, nodeIDs []string) (snapshots.Snapshot, error) {
	return f.created, f.createErr
}

func (f fakeSnapshotService) List() ([]snapshots.Snapshot, error) {
	return f.list, nil
}

func (f fakeSnapshotService) Apply(ctx context.Context, id string) (snapshots.ApplyResult, error) {
	return f.applyResult, f.applyErr
}

// fakeLauncherService ist ein Test-Double für LauncherService, damit
// Handler-Tests ohne echte Subprozesse auskommen.
type fakeLauncherService struct {
	catalog       []launcher.CatalogEntry
	instances     []launcher.Instance
	started       launcher.Instance
	startErr      error
	stopErr       error
	totalRestarts uint64
	importErr     error
	removeErr     error
}

func (f fakeLauncherService) Catalog() []launcher.CatalogEntry { return f.catalog }

func (f fakeLauncherService) List() []launcher.Instance { return f.instances }

func (f fakeLauncherService) Get(id string) (launcher.Instance, bool) {
	for _, inst := range f.instances {
		if inst.ID == id {
			return inst, true
		}
	}
	return launcher.Instance{}, false
}

func (f fakeLauncherService) Start(nodeType, version, hostID string, extraEnv map[string]string) (launcher.Instance, error) {
	return f.started, f.startErr
}

func (f fakeLauncherService) Stop(id string) error {
	return f.stopErr
}

func (f fakeLauncherService) TotalRestarts() uint64 { return f.totalRestarts }

func (f fakeLauncherService) ImportCatalogEntry(entry launcher.CatalogEntry) error {
	return f.importErr
}

func (f fakeLauncherService) RemoveCatalogEntry(nodeType, version string) error { return f.removeErr }

// fakeAuthSvc ist ein Test-Double für AuthService — UserCount 0 im
// Zero-Value (Bootstrap-Bypass, s. authGate.authenticate), damit alle
// bestehenden Handler-Tests oben unverändert das Vor-D3-Verhalten
// (offener Zugriff ohne angelegten Nutzer) prüfen. Tests, die
// tatsächliche Authentifizierung/Autorisierung prüfen, setzen die
// Felder gezielt (s. TestRequireVerb*-Tests unten).
type fakeAuthSvc struct {
	userCount       int
	principal       auth.Principal
	authenticateErr error
	loginToken      string
	loginExpires    time.Time
	loginErr        error
	createdUser     auth.User
	createErr       error
	listedUsers     []auth.User
	listErr         error
	deleteErr       error
	setPasswordErr  error
	serviceToken    string
	serviceExpires  time.Time
	serviceTokenErr error
}

func (f fakeAuthSvc) UserCount(ctx context.Context) (int, error) { return f.userCount, nil }

func (f fakeAuthSvc) Authenticate(token string) (auth.Principal, error) {
	return f.principal, f.authenticateErr
}

func (f fakeAuthSvc) Login(ctx context.Context, username, password string) (string, time.Time, error) {
	return f.loginToken, f.loginExpires, f.loginErr
}

func (f fakeAuthSvc) CreateUser(ctx context.Context, username, password string) (auth.User, error) {
	return f.createdUser, f.createErr
}

func (f fakeAuthSvc) ListUsers(ctx context.Context) ([]auth.User, error) {
	return f.listedUsers, f.listErr
}

func (f fakeAuthSvc) DeleteUser(ctx context.Context, username string) error {
	return f.deleteErr
}

func (f fakeAuthSvc) SetPassword(ctx context.Context, username, password string) error {
	return f.setPasswordErr
}

func (f fakeAuthSvc) IssueServiceToken(instanceID string) (string, time.Time, error) {
	return f.serviceToken, f.serviceExpires, f.serviceTokenErr
}

// fakeAuthzSvc ist ein Test-Double für AuthzChecker.
type fakeAuthzSvc struct {
	allowed          bool
	checkErr         error
	workflowAllowed  bool
	checkWorkflowErr error
	bindings         []authz.Binding
	loadErr          error
	created          authz.Binding
	createErr        error
	deleteErr        error
}

func (f fakeAuthzSvc) Check(subject, nodeID string, minVerb authz.Verb) (bool, error) {
	return f.allowed, f.checkErr
}

func (f fakeAuthzSvc) CheckWorkflow(subject, workflowID, role string, minVerb authz.Verb) (bool, error) {
	return f.workflowAllowed, f.checkWorkflowErr
}

func (f fakeAuthzSvc) Load() ([]authz.Binding, error) { return f.bindings, f.loadErr }

func (f fakeAuthzSvc) Create(subject, workflowID, nodeID string, verb authz.Verb) (authz.Binding, error) {
	return f.created, f.createErr
}

func (f fakeAuthzSvc) Delete(id string) error { return f.deleteErr }

// fakeAuditSvc implementiert sowohl AuditLogger als auch AuditReader —
// zeichnet Log()-Aufrufe auf, damit Tests sie nachprüfen können.
// lastBefore/lastLimit zeichnen den zuletzt an List() übergebenen
// Cursor auf (S5-Tests in auth_handlers_test.go: prüfen, dass
// handleListAuditLog Query-Parameter korrekt parst/begrenzt und
// durchreicht).
type fakeAuditSvc struct {
	entries []audit.Entry
	listErr error
	logged  []auditLogCall

	lastBefore int64
	lastLimit  int
}

type auditLogCall struct {
	Username, Method, Path, NodeID string
	Status                         int
}

func (f *fakeAuditSvc) Log(username, method, path, nodeID string, status int) {
	f.logged = append(f.logged, auditLogCall{username, method, path, nodeID, status})
}

func (f *fakeAuditSvc) List(before int64, limit int) ([]audit.Entry, error) {
	f.lastBefore, f.lastLimit = before, limit
	return f.entries, f.listErr
}

// fakeHostRegistry ist ein Test-Double für HostRegistry.
type fakeHostRegistry struct {
	token       string
	expiresAt   time.Time
	tokenErr    error
	consumeErr  error
	createdHost hosts.Host
	createErr   error
	list        []hosts.Host
	listErr     error
}

func (f fakeHostRegistry) CreateBootstrapToken(createdBy string, ttl time.Duration) (string, time.Time, error) {
	return f.token, f.expiresAt, f.tokenErr
}

func (f fakeHostRegistry) ConsumeBootstrapToken(token string) error { return f.consumeErr }

func (f fakeHostRegistry) CreateHost(label, hostname string, capabilities []byte) (hosts.Host, error) {
	return f.createdHost, f.createErr
}

func (f fakeHostRegistry) ListHosts() ([]hosts.Host, error) { return f.list, f.listErr }

// fakeHostMetrics ist ein Test-Double für HostMetricsReader.
type fakeHostMetrics struct {
	byHost map[string]hosts.Metrics
}

func (f fakeHostMetrics) Get(hostID string) (hosts.Metrics, bool) {
	m, ok := f.byHost[hostID]
	return m, ok
}

type fakeHostHistory struct {
	byHost map[string]hosts.HistoryWindow
}

func (f fakeHostHistory) Window(hostID string, window time.Duration) (hosts.HistoryWindow, bool) {
	w, ok := f.byHost[hostID]
	return w, ok
}

type fakeWorkflowService struct {
	created   workflows.Workflow
	createErr error
	list      []workflows.Workflow
	listErr   error
	get       workflows.Workflow
	getErr    error
	deleteErr error
	startErr  error
	stopErr   error
	updated   workflows.Workflow
	updateErr error
	pauseErr  error
	exported  workflows.ExportedWorkflow
	exportErr error
	imported  workflows.Workflow
	importErr error
	thumbnail []byte
	thumbOk   bool
	thumbErr  error
}

func (f fakeWorkflowService) Create(name string, def workflows.Definition, adopt map[string]workflows.RoleRuntime) (workflows.Workflow, error) {
	return f.created, f.createErr
}

func (f fakeWorkflowService) List() ([]workflows.Workflow, error) { return f.list, f.listErr }

func (f fakeWorkflowService) Get(id string) (workflows.Workflow, error) { return f.get, f.getErr }

func (f fakeWorkflowService) GetThumbnail(id string) ([]byte, bool, error) {
	return f.thumbnail, f.thumbOk, f.thumbErr
}

func (f fakeWorkflowService) Update(id, name string, def workflows.Definition) (workflows.Workflow, error) {
	return f.updated, f.updateErr
}

func (f fakeWorkflowService) Delete(id string) error { return f.deleteErr }

func (f fakeWorkflowService) Start(ctx context.Context, id string) error { return f.startErr }

func (f fakeWorkflowService) Stop(ctx context.Context, id string, confirm bool) error {
	return f.stopErr
}

func (f fakeWorkflowService) Pause(ctx context.Context, id string, confirm bool) error {
	return f.pauseErr
}

func (f fakeWorkflowService) Export(id string) (workflows.ExportedWorkflow, error) {
	return f.exported, f.exportErr
}

func (f fakeWorkflowService) Import(exported workflows.ExportedWorkflow) (workflows.Workflow, error) {
	return f.imported, f.importErr
}

func (f fakeWorkflowService) FindRoleForNode(nodeID string) (workflowID, workflowName, role string, ok bool) {
	return "", "", "", false
}

type fakePlacementAdvisor struct {
	advice []placement.Advice
}

func (f fakePlacementAdvisor) List() []placement.Advice { return f.advice }

type fakeProfileReader struct {
	snapshots map[[2]string]profiles.Snapshot
}

func (f fakeProfileReader) Get(_ context.Context, nodeType, hostID string) (profiles.Snapshot, bool, error) {
	snap, ok := f.snapshots[[2]string{nodeType, hostID}]
	return snap, ok, nil
}

func TestHandleHealthz(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %q, want %q", body["status"], "ok")
	}
}

func TestHandleInfo(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/info", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body InfoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if body.Name != AppName {
		t.Errorf("name = %q, want %q", body.Name, AppName)
	}
	if body.Version == "" {
		t.Error("version should not be empty")
	}
}

func TestHandleNodes(t *testing.T) {
	lister := fakeNodeLister{nodes: []registry.NodeView{
		{ID: "node-1", Label: "Fake Node", Online: true, Devices: []registry.DeviceView{}, Senders: []registry.SenderView{}, Receivers: []registry.ReceiverView{}},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body []registry.NodeView
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if len(body) != 1 || body[0].Label != "Fake Node" {
		t.Fatalf("nodes = %+v, want one Fake Node", body)
	}
}

func TestHandleNodesEmptyListSerializesAsEmptyArray(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if strings.TrimSpace(rec.Body.String()) != "[]" && strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("body = %q, want JSON array", rec.Body.String())
	}
}

func TestHandleEventsStreamsBroadcastEvents(t *testing.T) {
	ch := make(chan sse.Event, 1)
	ch <- sse.Event{Type: "omp.health.test", Data: []byte(`{"ok":true}`)}

	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: ch}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rec, req)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not return after context cancel")
	}

	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "omp.health.test") {
		t.Fatalf("body = %q, want to contain broadcast event type", body)
	}
	if !strings.Contains(body, `"ok":true`) {
		t.Fatalf("body = %q, want to contain event data", body)
	}
}

func TestHandleNodeProxyUIManifestAndBundle(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ui/manifest.json":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"name":"omp-mock-panel","version":"0.1.0","tag":"omp-mock-panel"}`))
		case "/ui/bundle.js":
			w.Header().Set("Content-Type", "text/javascript")
			w.Write([]byte(`customElements.define("omp-mock-panel", class extends HTMLElement {});`))
		default:
			t.Errorf("unexpected proxied path %q", r.URL.Path)
		}
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/ui/manifest.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("manifest status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "omp-mock-panel") {
		t.Fatalf("manifest body = %q, want to contain tag name", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/ui/bundle.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("bundle status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "customElements.define") {
		t.Fatalf("bundle body = %q, want to contain customElements.define", rec.Body.String())
	}
}

func TestHandleNodeProxyDescriptor(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/descriptor.json" {
			t.Errorf("proxied path = %q, want /descriptor.json", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"parameters":[{"name":"gain","type":"number","readonly":false}],"methods":[]}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/descriptor", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "gain") {
		t.Fatalf("body = %q, want to contain proxied descriptor", rec.Body.String())
	}
}

func TestHandleNodeProxyPatchParam(t *testing.T) {
	var gotBody string
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/params/gain" {
			t.Errorf("proxied request = %s %q, want PATCH /params/gain", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"value":-6}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", strings.NewReader(`{"value":-6}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotBody != `{"value":-6}` {
		t.Fatalf("proxied body = %q, want forwarded request body", gotBody)
	}
}

func TestHandleNodeProxyMethod(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/methods/reset" {
			t.Errorf("proxied request = %s %q, want POST /methods/reset", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/nodes/node-1/methods/reset", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandleNodeProxyUnknownNodeReturns404(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/does-not-exist/descriptor", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestHandleNodeStreamProxy (K4, docs/END-GOAL-FEATURES.md Kapitel 10
// Entscheidungssitzung Punkt 5): der generische Stream-Proxy löst
// zuerst "name" als Node-Parameter auf (zweiter Test-Server, simuliert
// den regulären Node-API-Port), behandelt den Wert als URL und
// streamt DANACH von einem zweiten, unabhängigen Server (simuliert
// z. B. `preview.rs`s eigenen zweiten Port) durch — der Aufrufer sieht
// nur die Orchestrator-URL, nie die tatsächliche Stream-Server-Adresse.
func TestHandleNodeStreamProxy(t *testing.T) {
	streamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/preview" {
			t.Errorf("stream path = %q, want /preview", r.URL.Path)
		}
		w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
		w.Write([]byte("--frame\r\nfake jpeg bytes\r\n"))
	}))
	defer streamServer.Close()

	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/params/previewUrl" {
			t.Errorf("param path = %q, want /params/previewUrl", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"value":%q}`, streamServer.URL+"/preview")
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/stream/previewUrl", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "multipart/x-mixed-replace; boundary=frame" {
		t.Fatalf("Content-Type = %q, want the stream server's own type", ct)
	}
	if !strings.Contains(rec.Body.String(), "fake jpeg bytes") {
		t.Fatalf("body = %q, want it to contain the streamed bytes", rec.Body.String())
	}
}

func TestHandleNodeStreamProxyUnknownParamReturns404(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unknown parameter", http.StatusNotFound)
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/stream/levelsUrl", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleNodeStreamProxyEmptyValueReturns404(t *testing.T) {
	nodeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"value":""}`))
	}))
	defer nodeServer.Close()

	lister := fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", APIBaseURL: nodeServer.URL}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, lister, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/stream/previewUrl", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (node has no preview configured)", rec.Code)
	}
}

func TestHandleNodeStreamProxyUnknownNodeReturns404(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes/does-not-exist/stream/previewUrl", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleGraph(t *testing.T) {
	svc := &fakeGraphService{g: graph.Graph{
		Nodes: []graph.Node{{ID: "node-1", Label: "Node 1"}},
		Edges: []graph.Edge{{ID: "recv-1", FromSender: "send-1", ToReceiver: "recv-1", State: "active"}},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, svc, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/graph", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body graph.Graph
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body.Edges) != 1 || body.Edges[0].FromSender != "send-1" {
		t.Fatalf("edges = %+v, want one edge from send-1", body.Edges)
	}
}

func TestHandlePostGraphEdge(t *testing.T) {
	svc := &fakeGraphService{}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, svc, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", strings.NewReader(`{"from":"send-1","to":"recv-1"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if svc.connectedFrom != "send-1" || svc.connectedTo != "recv-1" {
		t.Fatalf("Connect called with (%q, %q), want (send-1, recv-1)", svc.connectedFrom, svc.connectedTo)
	}
}

func TestHandlePostGraphEdgeUnknownReceiverReturns404(t *testing.T) {
	svc := &fakeGraphService{connectErr: graph.ErrUnknownReceiver}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, svc, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", strings.NewReader(`{"from":"send-1","to":"nope"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleDeleteGraphEdge(t *testing.T) {
	svc := &fakeGraphService{}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, svc, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/graph/edges/recv-1", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if svc.disconnectedID != "recv-1" {
		t.Fatalf("Disconnect called with %q, want recv-1", svc.disconnectedID)
	}
}

func TestHandleGetLayoutNotFound(t *testing.T) {
	store := fakeLayoutStore{data: map[string]json.RawMessage{}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, store, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/layouts/default", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandlePutThenGetLayoutRoundTrips(t *testing.T) {
	store := fakeLayoutStore{data: map[string]json.RawMessage{}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, store, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	body := `{"positions":{"node-1":{"x":1,"y":2}},"groups":{}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/layouts/default", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/layouts/default", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != body {
		t.Errorf("GET body = %s, want %s", rec.Body.String(), body)
	}
}

func TestHandlePutLayoutInvalidJSONReturns400(t *testing.T) {
	store := fakeLayoutStore{data: map[string]json.RawMessage{}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, store, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/layouts/default", strings.NewReader("not json")))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleListSnapshots(t *testing.T) {
	svc := fakeSnapshotService{list: []snapshots.Snapshot{{ID: "s1", Label: "Szene 1"}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, svc, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/snapshots", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []snapshots.Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body) != 1 || body[0].Label != "Szene 1" {
		t.Fatalf("snapshots = %+v, want one Szene 1", body)
	}
}

func TestHandleCreateSnapshot(t *testing.T) {
	svc := fakeSnapshotService{created: snapshots.Snapshot{ID: "s1", Label: "Szene 1"}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, svc, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/snapshots", strings.NewReader(`{"label":"Szene 1"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body snapshots.Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.ID != "s1" {
		t.Fatalf("snapshot = %+v, want ID s1", body)
	}
}

func TestHandleApplySnapshot(t *testing.T) {
	svc := fakeSnapshotService{applyResult: snapshots.ApplyResult{Errors: []string{}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, svc, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/snapshots/s1/apply", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body snapshots.ApplyResult
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body.Errors) != 0 {
		t.Fatalf("errors = %v, want none", body.Errors)
	}
}

func TestHandleApplySnapshotUnknownReturns404(t *testing.T) {
	svc := fakeSnapshotService{applyErr: snapshots.ErrNotFound}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, svc, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/snapshots/does-not-exist/apply", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestAPIResponsesAreNotCached(t *testing.T) {
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/nodes", nil))

	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestStaticUIServingIsNotForcedNoStore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}
	h := NewHandler(config.Config{UIDir: dir}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := rec.Header().Get("Cache-Control"); got == "no-store" {
		t.Error("static UI serving should not be forced to no-store")
	}
}

func TestStaticUIServing(t *testing.T) {
	dir := t.TempDir()
	const html = "<html><body>OpenMediaPlatform UI-Platzhalter</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}

	h := NewHandler(config.Config{UIDir: dir}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
		t.Fatalf("body does not contain <html>: %q", rec.Body.String())
	}
}

func TestHandleCatalog(t *testing.T) {
	svc := fakeLauncherService{catalog: []launcher.CatalogEntry{
		{Type: "omp-source", Label: "Source", Runner: "process", Command: []string{"bin"}},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []launcher.CatalogEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body) != 1 || body[0].Type != "omp-source" {
		t.Fatalf("catalog = %+v, want one omp-source entry", body)
	}
}

func TestHandlePostCatalogEntry(t *testing.T) {
	svc := fakeLauncherService{}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/catalog", strings.NewReader(`{"type":"acme-widget","runner":"podman","image":"example.com/acme/widget:1.0"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var body launcher.CatalogEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.Type != "acme-widget" {
		t.Fatalf("entry = %+v, want type acme-widget", body)
	}
}

// TestHandlePostCatalogEntryAdmissionFailureReturns422 prüft, dass ein
// abgelehnter Admission-Check (§17 Teil 4) den vollständigen
// checker.Result-Report im Response-Body mitliefert, nicht nur "422" —
// der Import-Nutzer muss sehen können, woran es lag (s.
// writeCatalogImportError-Doku).
func TestHandlePostCatalogEntryAdmissionFailureReturns422(t *testing.T) {
	svc := fakeLauncherService{importErr: &launcher.ErrAdmissionCheckFailed{Results: []checker.Result{
		{Name: "IS-04-Registrierung", Status: checker.StatusFail, Detail: "nicht gefunden"},
	}}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/catalog", strings.NewReader(`{"type":"acme-widget","runner":"podman","image":"example.com/acme/widget:1.0"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "IS-04-Registrierung") {
		t.Fatalf("body = %s, want it to contain the failed check name", rec.Body.String())
	}
}

func TestHandlePostCatalogEntryDuplicateTypeReturns409(t *testing.T) {
	svc := fakeLauncherService{importErr: launcher.ErrCatalogTypeExists}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/catalog", strings.NewReader(`{"type":"omp-source","runner":"podman","image":"x"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestHandleDeleteCatalogEntry(t *testing.T) {
	svc := fakeLauncherService{}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/catalog/acme-widget", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleDeleteCatalogEntryNotImportedReturns404(t *testing.T) {
	svc := fakeLauncherService{removeErr: launcher.ErrCatalogTypeNotImported}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/catalog/omp-source", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleListInstances(t *testing.T) {
	svc := fakeLauncherService{instances: []launcher.Instance{
		{ID: "inst-1", Type: "omp-source", Label: "Source (inst-1)", PID: 4242},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/instances", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []launcher.Instance
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(body) != 1 || body[0].ID != "inst-1" {
		t.Fatalf("instances = %+v, want one inst-1", body)
	}
}

// TestHandleListInstancesMergesRemoteInstanceMetrics (Kapitel 14 Teil
// 2): eine entfernte Instanz (HostID gesetzt) bekommt CPU%/RSS aus der
// zuletzt vom Host-Agent gemeldeten Telemetrie ihres Hosts nachgetragen
// — eine lokale Instanz (ohne HostID) oder eine bereits von svc.List()
// selbst befüllte (launcher.Launcher.sampleLocalResources()) bleibt
// unverändert.
func TestHandleListInstancesMergesRemoteInstanceMetrics(t *testing.T) {
	svc := fakeLauncherService{instances: []launcher.Instance{
		{ID: "inst-remote", Type: "omp-source", PID: 111, HostID: "host-1"},
		{ID: "inst-local", Type: "omp-source", PID: 222},
	}}
	metrics := fakeHostMetrics{byHost: map[string]hosts.Metrics{
		"host-1": {
			CPUPercent: 40,
			Instances: []hosts.InstanceMetrics{
				{InstanceID: "inst-remote", CPUPercent: 12.5, RSSBytes: 340 * 1024 * 1024},
				{InstanceID: "some-other-instance-on-the-same-host", CPUPercent: 99},
			},
		},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, metrics, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/instances", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body []launcher.Instance
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	byID := map[string]launcher.Instance{}
	for _, inst := range body {
		byID[inst.ID] = inst
	}

	remote := byID["inst-remote"]
	if remote.CPUPercent == nil || *remote.CPUPercent != 12.5 {
		t.Errorf("inst-remote.CPUPercent = %v, want 12.5", remote.CPUPercent)
	}
	if remote.RSSBytes == nil || *remote.RSSBytes != 340*1024*1024 {
		t.Errorf("inst-remote.RSSBytes = %v, want 340 MiB", remote.RSSBytes)
	}

	local := byID["inst-local"]
	if local.CPUPercent != nil || local.RSSBytes != nil {
		t.Errorf("inst-local (kein HostID) = %+v, want nil CPUPercent/RSSBytes (nur lokales Sampling befüllt das)", local)
	}
}

func TestHandlePostInstance(t *testing.T) {
	svc := fakeLauncherService{started: launcher.Instance{ID: "inst-1", Type: "omp-source", Label: "Source (inst-1)", PID: 4242}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances", strings.NewReader(`{"type":"omp-source"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body launcher.Instance
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body.ID != "inst-1" || body.PID != 4242 {
		t.Fatalf("instance = %+v, want inst-1/4242", body)
	}
}

func TestHandlePostInstanceUnknownTypeReturns404(t *testing.T) {
	svc := fakeLauncherService{startErr: launcher.ErrUnknownType}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances", strings.NewReader(`{"type":"does-not-exist"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleDeleteInstance(t *testing.T) {
	svc := fakeLauncherService{}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/instances/inst-1", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestHandleDeleteInstanceUnknownReturns404(t *testing.T) {
	svc := fakeLauncherService{stopErr: launcher.ErrUnknownInstance}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, svc, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/instances/does-not-exist", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleMeConsoles(t *testing.T) {
	resolver := fakeConsoleResolver{result: consoles.Result{
		HasEngineeringAccess: false,
		Consoles: []consoles.ConsoleEntry{
			{WorkflowID: "default", WorkflowLabel: "Regieplatz", NodeRoleID: "inst-1", NodeLabel: "Video Mixer M/E", UIBundleURL: "/api/v1/nodes/node-1"},
		},
	}}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, resolver, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/me/consoles", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body consoles.Result
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body: %v", err)
	}
	if len(body.Consoles) != 1 || body.Consoles[0].NodeRoleID != "inst-1" {
		t.Fatalf("body = %+v, unexpected", body)
	}
}

func TestHandleMeConsolesPropagatesStoreError(t *testing.T) {
	resolver := fakeConsoleResolver{err: errors.New("boom")}
	h := NewHandler(config.Config{UIDir: t.TempDir()}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, resolver, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/me/consoles", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestConsoleKioskRouteFallsBackToIndexHTML(t *testing.T) {
	dir := t.TempDir()
	const html = "<html><body>OpenMediaPlatform UI-Platzhalter</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o644); err != nil {
		t.Fatalf("failed to write placeholder index.html: %v", err)
	}
	h := NewHandler(config.Config{UIDir: dir}, fakeNodeLister{}, fakeEventSubscriber{ch: make(chan sse.Event)}, &fakeGraphService{}, fakeLayoutStore{}, fakeSnapshotService{}, fakeLauncherService{}, fakeConsoleResolver{}, nil, fakeAuthSvc{}, fakeAuthzSvc{}, &fakeAuditSvc{}, &fakeAuditSvc{}, fakeHostRegistry{}, fakeHostMetrics{}, fakeHostHistory{}, fakeWorkflowService{}, fakePlacementAdvisor{}, fakeProfileReader{}, placement.Thresholds{})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/console/default/inst-1", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("body does not contain <html>: %q", rec.Body.String())
	}
}

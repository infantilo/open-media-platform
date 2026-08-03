package workflows

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// fakeHostMetrics ist ein Test-Double für HostMetricsReader (failover.go).
type fakeHostMetrics struct {
	mu    sync.Mutex
	byID  map[string]hosts.Metrics
	known map[string]bool
}

func newFakeHostMetrics() *fakeHostMetrics {
	return &fakeHostMetrics{byID: map[string]hosts.Metrics{}, known: map[string]bool{}}
}

func (f *fakeHostMetrics) set(hostID string, receivedAt time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[hostID] = hosts.Metrics{ReceivedAt: receivedAt}
	f.known[hostID] = true
}

func (f *fakeHostMetrics) Get(hostID string) (hosts.Metrics, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.byID[hostID], f.known[hostID]
}

// setupRedundantWorkflow startet einen echten Workflow (Create+Start, wie
// TestInstanceRestartedRewiresAffectedRole) mit drei Rollen: "src"
// (omp-source, ein Sender), "active" (omp-viewer, Primärrolle, ein
// Receiver) und "standby" (omp-viewer, StandbyFor: "active", eigener
// Receiver) — nur src->active ist als Connection modelliert, "standby"
// bleibt beim Start bewusst unverbunden (s. types.go-Doku zu StandbyFor).
// Liefert svc, den gestarteten Workflow, sowie die Instanz-IDs von
// active/standby.
func setupRedundantWorkflow(t *testing.T) (svc *Service, nodes *fakeNodeLister, g *fakeGraph, l *fakeLauncher, wf Workflow, activeInstance, standbyInstance string) {
	t.Helper()
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { registrationTimeout, registrationPollInterval = original, originalPoll })

	nodes = &fakeNodeLister{}
	g = &fakeGraph{}
	l = &fakeLauncher{}
	svc = newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"},
			{Name: "active", NodeType: "omp-viewer", RedundancyGroup: "viewer-red"},
			{Name: "standby", NodeType: "omp-viewer", StandbyFor: "active", RedundancyGroup: "viewer-red"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "active"}},
	}
	created, err := svc.Create("regie", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), created.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		startedCount := len(l.started)
		l.mu.Unlock()
		if startedCount == 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	srcInstance := l.instanceIDFor("omp-source")
	// omp-viewer wird zweimal gestartet (active+standby) — instanceIDFor
	// liefert nur den LETZTEN Start dieses Typs, deshalb hier direkt über
	// l.started/id-Konvention aufgelöst statt instanceIDFor zu
	// missbrauchen (dessen Ein-Eintrag-pro-Typ-Map für zwei gleichzeitige
	// Instanzen desselben Typs nicht reicht).
	l.mu.Lock()
	var viewerInstances []string
	for i, nodeType := range l.started {
		if nodeType == "omp-viewer" {
			viewerInstances = append(viewerInstances, "omp-viewer-instance-"+strconv.Itoa(i+1))
		}
	}
	l.mu.Unlock()
	if len(viewerInstances) != 2 {
		t.Fatalf("expected 2 omp-viewer instances, got %v", viewerInstances)
	}
	activeInstance, standbyInstance = viewerInstances[0], viewerInstances[1]

	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-src"}}})
	nodes.add(registry.NodeView{ID: "node-active", InstanceID: activeInstance, Receivers: []registry.ReceiverView{{ID: "recv-active"}}})
	nodes.add(registry.NodeView{ID: "node-standby", InstanceID: standbyInstance, Receivers: []registry.ReceiverView{{ID: "recv-standby"}}})
	wf = waitForStatus(t, svc, created.ID, StatusStarted)

	// Standby-Rolle muss registriert (discoverable), aber laut Design
	// unverbunden sein — kein Connect-Aufruf für sie.
	if wf.Runtime["standby"].NodeID != "node-standby" {
		t.Fatalf("standby role not registered, runtime = %+v", wf.Runtime)
	}
	g.mu.Lock()
	callsAfterStart := len(g.calls)
	g.mu.Unlock()
	if callsAfterStart != 1 {
		t.Fatalf("connect calls after start = %d, want exactly 1 (src->active only, standby stays unconnected)", callsAfterStart)
	}
	return svc, nodes, g, l, wf, activeInstance, standbyInstance
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// TestInstanceGaveUpPromotesStandby deckt Trigger 1 (Crash-Loop erschöpft)
// ab: InstanceGaveUp(activeInstance) muss die Rolle "active" auf die
// bereits laufende Standby-Instanz umziehen und die betroffene Connection
// neu anwenden (jetzt auf recv-standby statt recv-active).
func TestInstanceGaveUpPromotesStandby(t *testing.T) {
	svc, _, g, _, wf, activeInstance, standbyInstance := setupRedundantWorkflow(t)

	events := &fakeEventPublisher{}
	svc.events = events

	svc.InstanceGaveUp(activeInstance)

	deadline := time.Now().Add(2 * time.Second)
	var after Workflow
	for time.Now().Before(deadline) {
		var err error
		after, err = svc.Get(wf.ID)
		if err != nil {
			t.Fatalf("Get() error = %v", err)
		}
		if after.Runtime["active"].InstanceID == standbyInstance {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if after.Runtime["active"].InstanceID != standbyInstance {
		t.Fatalf("Runtime[\"active\"].InstanceID = %q, want %q after promotion", after.Runtime["active"].InstanceID, standbyInstance)
	}
	if !after.Runtime["active"].StandbyActive {
		t.Errorf("Runtime[\"active\"].StandbyActive = false, want true after promotion")
	}
	if after.Runtime["active"].NodeID != "node-standby" {
		t.Errorf("Runtime[\"active\"].NodeID = %q, want node-standby", after.Runtime["active"].NodeID)
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("connect calls after promotion = %+v, want 2 (initial + reconnect to standby)", g.calls)
	}
	if g.calls[1].fromSender != "send-src" || g.calls[1].toReceiver != "recv-standby" {
		t.Errorf("second connect call = %+v, want send-src -> recv-standby", g.calls[1])
	}

	var sawFailoverEvent bool
	for _, typ := range events.types {
		if typ == "workflow.failover" {
			sawFailoverEvent = true
		}
	}
	if !sawFailoverEvent {
		t.Errorf("events = %v, want a workflow.failover event", events.types)
	}
}

// TestPromoteStandbyIsIdempotent stellt sicher, dass ein zweiter
// Übernahme-Versuch derselben Rolle (z. B. weil Crash-Loop- UND
// Host-Offline-Trigger kurz hintereinander feuern) keinen zweiten
// Connect-Aufruf/kein zweites Event auslöst — die Rolle zeigt bereits auf
// die Standby-Instanz.
func TestPromoteStandbyIsIdempotent(t *testing.T) {
	svc, _, g, _, wf, activeInstance, standbyInstance := setupRedundantWorkflow(t)

	svc.promoteStandby(wf, "active", "standby", "crash-loop")
	after, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if after.Runtime["active"].InstanceID != standbyInstance {
		t.Fatalf("first promotion did not take effect, runtime = %+v", after.Runtime)
	}
	g.mu.Lock()
	callsAfterFirst := len(g.calls)
	g.mu.Unlock()

	// Zweiter Versuch mit demselben (jetzt veralteten) primaryInstance-
	// Ausgangszustand — promoteStandby lädt intern frisch aus dem Store,
	// erkennt also, dass "active" bereits auf standbyInstance zeigt.
	svc.promoteStandby(after, "active", "standby", "host-offline")

	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != callsAfterFirst {
		t.Errorf("connect calls after second (idempotent) promotion = %d, want unchanged %d", len(g.calls), callsAfterFirst)
	}
	_ = activeInstance
}

// TestCheckHostOfflineTriggersFailover deckt Trigger 2 ab: eine Rolle mit
// Standby, deren Host seit hostOfflineTimeout keine Telemetrie mehr
// gesendet hat, wird übernommen — unabhängig von jedem Crash-Loop-Event
// (kein NATS-Exit-Event nötig, das ist ja gerade der Witz dieses
// Triggers).
func TestCheckHostOfflineTriggersFailover(t *testing.T) {
	svc, _, _, _, wf, _, standbyInstance := setupRedundantWorkflow(t)

	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)

	// "active" lief in setupRedundantWorkflow lokal (HostID=="", s.
	// StartLabeled-Fake) — für den Host-Offline-Test wird die Runtime
	// direkt auf einen Remote-Host umgebogen (der Orchestrator misst sich
	// selbst nicht, s. checkHostOffline-Doku).
	rt := wf.Runtime["active"]
	rt.HostID = "remote-host-1"
	wf.Runtime["active"] = rt
	if err := svc.store.UpdateRuntime(wf); err != nil {
		t.Fatalf("UpdateRuntime() error = %v", err)
	}

	// Frische Telemetrie -> kein Failover.
	metrics.set("remote-host-1", time.Now())
	svc.checkHostOffline(wf, "active", "standby")
	time.Sleep(50 * time.Millisecond)
	stillActive, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if stillActive.Runtime["active"].InstanceID == standbyInstance {
		t.Fatalf("promotion happened despite fresh telemetry")
	}

	// Veraltete Telemetrie (> hostOfflineTimeout) -> Failover.
	metrics.set("remote-host-1", time.Now().Add(-2*hostOfflineTimeout))
	svc.checkHostOffline(wf, "active", "standby")

	deadline := time.Now().Add(2 * time.Second)
	var after Workflow
	for time.Now().Before(deadline) {
		after, err = svc.Get(wf.ID)
		if err != nil {
			t.Fatalf("Get() error = %v", err)
		}
		if after.Runtime["active"].InstanceID == standbyInstance {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if after.Runtime["active"].InstanceID != standbyInstance {
		t.Fatalf("Runtime[\"active\"].InstanceID = %q, want %q after host-offline promotion", after.Runtime["active"].InstanceID, standbyInstance)
	}
}

func TestCreateRejectsInvalidStandbyFor(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})

	cases := []struct {
		name string
		def  Definition
	}{
		{
			name: "self-reference",
			def: Definition{Roles: []Role{
				{Name: "a", NodeType: "omp-viewer", StandbyFor: "a"},
			}},
		},
		{
			name: "unknown primary",
			def: Definition{Roles: []Role{
				{Name: "a", NodeType: "omp-viewer", StandbyFor: "does-not-exist"},
			}},
		},
		{
			name: "nodeType mismatch",
			def: Definition{Roles: []Role{
				{Name: "a", NodeType: "omp-viewer"},
				{Name: "b", NodeType: "omp-scaler", StandbyFor: "a"},
			}},
		},
		{
			name: "chain (standby of a standby)",
			def: Definition{Roles: []Role{
				{Name: "a", NodeType: "omp-viewer"},
				{Name: "b", NodeType: "omp-viewer", StandbyFor: "a"},
				{Name: "c", NodeType: "omp-viewer", StandbyFor: "b"},
			}},
		},
		{
			name: "two standbys for the same primary",
			def: Definition{Roles: []Role{
				{Name: "a", NodeType: "omp-viewer"},
				{Name: "b", NodeType: "omp-viewer", StandbyFor: "a"},
				{Name: "c", NodeType: "omp-viewer", StandbyFor: "a"},
			}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.Create("wf-"+tc.name, tc.def, nil); err == nil {
				t.Fatalf("Create() error = nil, want ErrValidation")
			}
		})
	}
}

func TestCreateAcceptsValidStandbyFor(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := Definition{Roles: []Role{
		{Name: "active", NodeType: "omp-viewer"},
		{Name: "standby", NodeType: "omp-viewer", StandbyFor: "active"},
	}}
	wf, err := svc.Create("wf-valid-standby", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	got, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Definition.Roles[1].StandbyFor != "active" {
		t.Errorf("StandbyFor = %q, want %q", got.Definition.Roles[1].StandbyFor, "active")
	}
}

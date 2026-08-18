package workflows

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// awaitAndRegisterFakeNode wartet, bis fakeLauncher eine Instanz von
// nodeType gestartet hat, und meldet sie dann im fakeNodeLister als
// registriert an — gleiches Muster wie
// TestSchedulerLastFiredAtSurvivesConcurrentRunStart (scheduler_test.go):
// runStart() wartet in awaitRegistration auf genau dieses Erscheinen,
// ohne es hängt der Start bis registrationTimeout.
func awaitAndRegisterFakeNode(t *testing.T, l *fakeLauncher, nodes *fakeNodeLister, nodeType, nodeID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if instID := l.instanceIDFor(nodeType); instID != "" {
			nodes.add(registry.NodeView{ID: nodeID, InstanceID: instID})
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("fakeLauncher never started an instance of type %q within 1s", nodeType)
}

// fakeIOPort ist ein im Test deklarierter, verfügbarer physischer Port —
// Test-Double für das Host-Agent-Inventar (ioports.Store, echte
// Postgres-Tests dort in internal/ioports).
type fakeIOPort struct {
	hostID, portID, cardType, direction string
}

type fakeIOClaim struct {
	hostID, portID, workflowID, role, instanceID string
}

// fakeIOPortClaimer ist ein Test-Double für IOPortClaimer (gleiches
// Muster wie fakeResourcePrecheck) — hält Ports/Claims rein im Speicher,
// die eigentliche Postgres-Atomarität ist bereits in
// internal/ioports/ioports_test.go verifiziert (inkl. echter
// Nebenläufigkeit), hier geht es nur um die Verdrahtung in
// workflows.Service.
type fakeIOPortClaimer struct {
	mu      sync.Mutex
	ports   []fakeIOPort
	claimed map[string]fakeIOClaim // "hostID/portID" -> Claim
}

func newFakeIOPortClaimer(ports ...fakeIOPort) *fakeIOPortClaimer {
	return &fakeIOPortClaimer{ports: ports, claimed: map[string]fakeIOClaim{}}
}

func (f *fakeIOPortClaimer) Claim(cardType, direction, preferredHostID, workflowID, role, instanceID string) (string, string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.ports {
		if p.cardType != cardType || p.direction != direction {
			continue
		}
		if preferredHostID != "" && p.hostID != preferredHostID {
			continue
		}
		key := p.hostID + "/" + p.portID
		if _, taken := f.claimed[key]; taken {
			continue
		}
		f.claimed[key] = fakeIOClaim{hostID: p.hostID, portID: p.portID, workflowID: workflowID, role: role, instanceID: instanceID}
		return p.hostID, p.portID, true, nil
	}
	return "", "", false, nil
}

func (f *fakeIOPortClaimer) UpdateInstanceID(workflowID, role, instanceID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, c := range f.claimed {
		if c.workflowID == workflowID && c.role == role {
			c.instanceID = instanceID
			f.claimed[k] = c
		}
	}
	return nil
}

func (f *fakeIOPortClaimer) Release(workflowID, role string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, c := range f.claimed {
		if c.workflowID == workflowID && c.role == role {
			delete(f.claimed, k)
		}
	}
	return nil
}

func (f *fakeIOPortClaimer) GetClaim(workflowID, role string) (string, string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.claimed {
		if c.workflowID == workflowID && c.role == role {
			return c.hostID, c.portID, true, nil
		}
	}
	return "", "", false, nil
}

func (f *fakeIOPortClaimer) ReleasePort(hostID, portID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.claimed, hostID+"/"+portID)
	return nil
}

func (f *fakeIOPortClaimer) claimCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.claimed)
}

func TestStartClaimsIOPortForRequiredRole(t *testing.T) {
	original := registrationTimeout
	registrationTimeout = 2 * time.Second
	defer func() { registrationTimeout = original }()

	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	ioPorts := newFakeIOPortClaimer(fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "in"})
	svc.SetIOPortClaimer(ioPorts)

	def := Definition{Roles: []Role{{Name: "ingest", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}}}
	wf, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	awaitAndRegisterFakeNode(t, l, nodes, "omp-decklink", "node-ingest")
	started := waitForStatus(t, svc, wf.ID, StatusStarted)

	if started.Runtime["ingest"].HostID != "host-1" {
		t.Errorf("Runtime[ingest].HostID = %q, want host-1 (the host with the claimed port)", started.Runtime["ingest"].HostID)
	}
	if ioPorts.claimCount() != 1 {
		t.Errorf("claimCount() = %d, want 1", ioPorts.claimCount())
	}
}

func TestStartRejectsWhenNoMatchingIOPortAvailable(t *testing.T) {
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	// Nur ein "out"-Port vorhanden, die Rolle braucht "in".
	ioPorts := newFakeIOPortClaimer(fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "out"})
	svc.SetIOPortClaimer(ioPorts)

	def := Definition{Roles: []Role{{Name: "ingest", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}}}
	wf, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	err = svc.Start(context.Background(), wf.ID)
	if err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("Start() error = %v, want ErrValidation (honest rejection, no free port)", err)
	}

	// Der Workflow darf NIE "starting" erreicht haben — die Ablehnung
	// muss VOR jeder Provisionierung passieren (s. claimIOPortsForStart-
	// Doku), kein Teil-Start.
	got, _ := svc.Get(wf.ID)
	if got.Status != StatusStopped {
		t.Errorf("Status = %q, want %q (rejected before any provisioning)", got.Status, StatusStopped)
	}
	if len(l.started) != 0 {
		t.Errorf("launcher.Start() calls = %d, want 0 — nothing should have been provisioned", len(l.started))
	}
	if ioPorts.claimCount() != 0 {
		t.Errorf("claimCount() = %d, want 0 (nothing should remain claimed)", ioPorts.claimCount())
	}
}

func TestStartRejectsWhenIOPortRequiredButNoClaimerConfigured(t *testing.T) {
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	// svc.ioPorts bleibt bewusst nil (kein SetIOPortClaimer-Aufruf) —
	// eine deklarierte Hardware-Anforderung darf dadurch nicht
	// stillschweigend ignoriert werden.

	def := Definition{Roles: []Role{{Name: "ingest", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}}}
	wf, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := svc.Start(context.Background(), wf.ID); err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("Start() error = %v, want ErrValidation", err)
	}
	if len(l.started) != 0 {
		t.Errorf("launcher.Start() calls = %d, want 0", len(l.started))
	}
}

func TestStartRollsBackPartialClaimsWhenALaterRoleCannotBeSatisfied(t *testing.T) {
	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	// Nur EIN passender Port existiert, aber ZWEI Rollen brauchen einen.
	ioPorts := newFakeIOPortClaimer(fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "in"})
	svc.SetIOPortClaimer(ioPorts)

	def := Definition{Roles: []Role{
		{Name: "ingest-a", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}},
		{Name: "ingest-b", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}},
	}}
	wf, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := svc.Start(context.Background(), wf.ID); err == nil || !errors.Is(err, ErrValidation) {
		t.Fatalf("Start() error = %v, want ErrValidation", err)
	}
	if ioPorts.claimCount() != 0 {
		t.Errorf("claimCount() = %d, want 0 — the successful first claim must be rolled back when the second role cannot be satisfied", ioPorts.claimCount())
	}
	if len(l.started) != 0 {
		t.Errorf("launcher.Start() calls = %d, want 0 — rejection happens before any provisioning", len(l.started))
	}
}

func TestStopReleasesIOPortClaim(t *testing.T) {
	original := registrationTimeout
	registrationTimeout = 2 * time.Second
	defer func() { registrationTimeout = original }()

	nodes := &fakeNodeLister{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	ioPorts := newFakeIOPortClaimer(fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "in"})
	svc.SetIOPortClaimer(ioPorts)

	def := Definition{Roles: []Role{{Name: "ingest", NodeType: "omp-decklink", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}}}
	wf, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	awaitAndRegisterFakeNode(t, l, nodes, "omp-decklink", "node-ingest")
	waitForStatus(t, svc, wf.ID, StatusStarted)
	if ioPorts.claimCount() != 1 {
		t.Fatalf("claimCount() after Start() = %d, want 1", ioPorts.claimCount())
	}

	if err := svc.Stop(context.Background(), wf.ID, false); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	waitForStatus(t, svc, wf.ID, StatusStopped)

	if ioPorts.claimCount() != 0 {
		t.Errorf("claimCount() after Stop() = %d, want 0", ioPorts.claimCount())
	}

	// Der Port muss jetzt wieder für einen anderen Workflow claimbar sein.
	_, _, ok, err := ioPorts.Claim("decklink", "in", "", "wf2", "other", "")
	if err != nil || !ok {
		t.Errorf("Claim() after release = (ok=%v, err=%v), want ok=true", ok, err)
	}
}

// setupIOPortMigrationWorkflow startet einen Ein-Rollen-Workflow, dessen
// einzige Rolle einen I/O-Port auf host-1 braucht (dort bereits durch
// den Start() claimt, s. claimIOPortsForStart) — Grundlage für die
// Migrations-Grenze-Tests unten (ARCHITECTURE.md §6.1 Erweiterung
// 2026-07-10 Punkt 3).
func setupIOPortMigrationWorkflow(t *testing.T, ioPorts *fakeIOPortClaimer) (svc *Service, nodes *fakeNodeLister, l *fakeLauncher, wfID, oldInstance string) {
	t.Helper()
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 2 * time.Second
	registrationPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { registrationTimeout, registrationPollInterval = original, originalPoll })

	nodes = &fakeNodeLister{}
	l = &fakeLauncher{}
	svc = newTestService(newFakeStore(), nodes, &fakeGraph{}, l)
	svc.SetIOPortClaimer(ioPorts)

	def := Definition{Roles: []Role{{Name: "ingest", NodeType: "omp-decklink", HostID: "host-1", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}}}
	created, err := svc.Create("wf", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), created.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	awaitAndRegisterFakeNode(t, l, nodes, "omp-decklink", "node-ingest")
	waitForStatus(t, svc, created.ID, StatusStarted)

	oldInstance = l.instanceIDFor("omp-decklink")
	return svc, nodes, l, created.ID, oldInstance
}

func TestMigrateRoleRejectsWhenTargetHostHasNoFreeIOPort(t *testing.T) {
	// Nur host-1 hat einen Port — host-2 (das Migrationsziel) keinen.
	ioPorts := newFakeIOPortClaimer(fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "in"})
	svc, _, l, wfID, oldInstance := setupIOPortMigrationWorkflow(t, ioPorts)

	err := svc.MigrateRole(context.Background(), wfID, "ingest", "host-2")
	if err != nil {
		// MigrateRole selbst stößt nur asynchron an (s. dortige Doku) —
		// ein Fehler hier wäre nur ein Validierungsfehler VOR dem
		// eigentlichen Migrationsversuch (z. B. unbekannte Rolle), nicht
		// die hier geprüfte "nicht migrierbar"-Ablehnung.
		t.Fatalf("MigrateRole() error = %v", err)
	}

	// executeMigration läuft asynchron — kurz warten und sicherstellen,
	// dass NICHTS passiert ist: keine neue Instanz, alte Instanz weiter
	// unangetastet, kein zweiter Claim.
	time.Sleep(200 * time.Millisecond)

	l.mu.Lock()
	started := len(l.started)
	stopped := len(l.stopped)
	l.mu.Unlock()
	if started != 1 {
		t.Errorf("launcher.Start() calls = %d, want 1 (only the original start, no migration attempt started a new instance)", started)
	}
	if stopped != 0 {
		t.Errorf("launcher.Stop() calls = %d, want 0 (old instance must keep running, migration was rejected)", stopped)
	}
	if ioPorts.claimCount() != 1 {
		t.Errorf("claimCount() = %d, want 1 (still only the original claim on host-1)", ioPorts.claimCount())
	}
	wf, err := svc.Get(wfID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if wf.Runtime["ingest"].InstanceID != oldInstance || wf.Runtime["ingest"].HostID != "host-1" {
		t.Errorf("Runtime[ingest] = %+v, want unchanged (still on host-1, instance %q)", wf.Runtime["ingest"], oldInstance)
	}
}

func TestMigrateRoleMovesIOPortClaimOnSuccess(t *testing.T) {
	ioPorts := newFakeIOPortClaimer(
		fakeIOPort{hostID: "host-1", portID: "p1", cardType: "decklink", direction: "in"},
		fakeIOPort{hostID: "host-2", portID: "p2", cardType: "decklink", direction: "in"},
	)
	svc, nodes, l, wfID, oldInstance := setupIOPortMigrationWorkflow(t, ioPorts)

	if err := svc.MigrateRole(context.Background(), wfID, "ingest", "host-2"); err != nil {
		t.Fatalf("MigrateRole() error = %v", err)
	}

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 2
	})
	newInstance := l.instanceIDFor("omp-decklink")
	if newInstance == oldInstance {
		t.Fatalf("expected a fresh instance ID for the migrated role")
	}
	nodes.add(registry.NodeView{ID: "node-ingest-2", InstanceID: newInstance})

	waitFor(t, func() bool {
		wf, err := svc.Get(wfID)
		if err != nil {
			return false
		}
		return wf.Runtime["ingest"].InstanceID == newInstance && wf.Runtime["ingest"].HostID == "host-2"
	})

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, id := range l.stopped {
			if id == oldInstance {
				return true
			}
		}
		return false
	})

	// Nach abgeschlossenem Cutover: genau EIN Claim, auf host-2 (der
	// alte auf host-1 wurde freigegeben, s. executeMigration Schritt 6).
	waitFor(t, func() bool { return ioPorts.claimCount() == 1 })
	if _, taken := ioPorts.claimed["host-1/p1"]; taken {
		t.Error("host-1/p1 is still claimed, want released after successful cutover")
	}
	if c, taken := ioPorts.claimed["host-2/p2"]; !taken || c.instanceID != newInstance {
		t.Errorf("host-2/p2 claim = %+v (taken=%v), want claimed by instance %q", c, taken, newInstance)
	}
}

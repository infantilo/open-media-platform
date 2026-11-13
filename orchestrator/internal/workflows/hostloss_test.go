package workflows

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// fixedPlacer wählt immer denselben Host (Test-Double für die Platzwahl).
type fixedPlacer struct{ host string }

func (f fixedPlacer) CheckHost(hostID, nodeType string) (string, bool) { return "", true }
func (f fixedPlacer) SelectHost(placement.PlacementRequest, placement.Occupancy) placement.PlacementResult {
	return placement.PlacementResult{HostID: f.host}
}
func (f fixedPlacer) ProjectedLoad(nodeType, hostID string) profiles.Snapshot {
	return profiles.Snapshot{}
}

func setRoleHost(t *testing.T, svc *Service, wfID, role, hostID string) Workflow {
	t.Helper()
	wf, err := svc.Get(wfID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	rt := wf.Runtime[role]
	rt.HostID = hostID
	wf.Runtime[role] = rt
	if err := svc.store.UpdateRuntime(wf); err != nil {
		t.Fatalf("UpdateRuntime() error = %v", err)
	}
	return wf
}

// TestLostHostRelocatesRoleWithoutStandby — fällt der Host einer Rolle ohne Standby aus, zieht sie auf einen anderen
// Host um: neue Instanz mit dem Rollen-Seed (gleiche IDs), Stop der verlorenen beim Launcher (dort vorgemerkt).
func TestLostHostRelocatesRoleWithoutStandby(t *testing.T) {
	svc, nodes, _, l, wfID, activeInstance := setupMigrationWorkflow(t, "", 0)
	svc.resources = fixedPlacer{host: "host-b"}
	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)
	setRoleHost(t, svc, wfID, "active", "host-a")
	l.mu.Lock()
	l.stopErrs = map[string]error{activeInstance: fmt.Errorf("%w: no responders", launcher.ErrStopDeferred)}
	l.mu.Unlock()

	// Frische Telemetrie: nichts passiert.
	metrics.set("host-a", time.Now())
	svc.failoverTick()
	time.Sleep(50 * time.Millisecond)
	l.mu.Lock()
	n := len(l.started)
	l.mu.Unlock()
	if n != 2 {
		t.Fatalf("relocation started although the host is online (%d starts)", n)
	}

	metrics.set("host-a", time.Now().Add(-2*defaultHostLossRelocateAfter))
	svc.failoverTick()
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	l.mu.Lock()
	env := l.lastExtraEnv["omp-viewer"]
	l.mu.Unlock()
	if env[roleSeedEnvKey] == "" {
		t.Errorf("relocated instance started without the role seed: %+v", env)
	}
	nodes.add(registry.NodeView{ID: "node-active", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active"}}})

	waitFor(t, func() bool {
		wf, err := svc.Get(wfID)
		return err == nil && wf.Runtime["active"].InstanceID == newInstance && wf.Runtime["active"].MigratedFrom == nil
	})
	wf, _ := svc.Get(wfID)
	if wf.Runtime["active"].HostID != "host-b" {
		t.Fatalf("relocated role host = %q, want host-b", wf.Runtime["active"].HostID)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	stopped := false
	for _, id := range l.stopped {
		stopped = stopped || id == activeInstance
	}
	if !stopped {
		t.Errorf("stop of the lost instance was not handed to the launcher (needed for the deferred stop)")
	}
}

// TestLostHostDoesNotRelocateOnGoodbyeOrPolicy — ein abgemeldeter Host-Agent (absichtlich beendet) und Rollen mit
// "stay" lösen keinen Umzug aus; OMP_HOST_FAILURE_RELOCATE=off schaltet ihn systemweit ab.
func TestLostHostDoesNotRelocateOnGoodbyeOrPolicy(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)

	metrics.mu.Lock()
	metrics.byID["host-a"] = hosts.Metrics{ReceivedAt: time.Now().Add(-time.Hour), Goodbye: true}
	metrics.known["host-a"] = true
	metrics.mu.Unlock()
	if svc.hostLostForRelocation("host-a") {
		t.Errorf("host that said goodbye counts as lost")
	}
	metrics.set("host-b", time.Now().Add(-time.Hour))
	if !svc.hostLostForRelocation("host-b") {
		t.Errorf("silent host without goodbye must count as lost")
	}

	if !relocatesOnHostLoss(Role{}) {
		t.Errorf("default must be to relocate")
	}
	if relocatesOnHostLoss(Role{Placement: &RolePlacementPolicy{OnHostFailure: HostFailureStay}}) {
		t.Errorf("role with onHostFailure=stay must not relocate")
	}
	t.Setenv("OMP_HOST_FAILURE_RELOCATE", "off")
	if relocatesOnHostLoss(Role{}) {
		t.Errorf("OMP_HOST_FAILURE_RELOCATE=off must switch the default off")
	}
	if !relocatesOnHostLoss(Role{Placement: &RolePlacementPolicy{OnHostFailure: HostFailureRelocate}}) {
		t.Errorf("role with onHostFailure=relocate must relocate even if the default is off")
	}
}

// TestMigrationRollsBackWhenConnectionToNewInstanceFails — lässt sich die Verbindung nicht auf die neue Instanz
// legen, bleibt die Rolle auf der alten (die noch läuft); die neue wird gestoppt, die alte nicht.
func TestMigrationRollsBackWhenConnectionToNewInstanceFails(t *testing.T) {
	svc, nodes, g, l, wfID, activeInstance := setupMigrationWorkflow(t, "", 0)
	g.mu.Lock()
	g.err = errors.New("receiver rejected the connection")
	g.mu.Unlock()

	if err := svc.MigrateRole(context.Background(), wfID, "active", "host-b"); err != nil {
		t.Fatalf("MigrateRole() error = %v", err)
	}
	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 3
	})
	newInstance := l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-active-2", InstanceID: newInstance, Receivers: []registry.ReceiverView{{ID: "recv-active-2"}}})

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, id := range l.stopped {
			if id == newInstance {
				return true
			}
		}
		return false
	})
	wf, err := svc.Get(wfID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	rt := wf.Runtime["active"]
	if rt.InstanceID != activeInstance || rt.MigratedFrom != nil || rt.MigratingTo != "" {
		t.Fatalf("runtime after rollback = %+v, want the old instance %s without journal", rt, activeInstance)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, id := range l.stopped {
		if id == activeInstance {
			t.Fatalf("old instance was stopped although the migration was rolled back")
		}
	}
}

// TestReconcileMigrationJournalCleansUpInterruptedMigration — bricht der Orchestrator mitten im Umzug ab, steht im
// Journal, welche Instanz übrig ist: nach dem Umschalten die alte, davor die neue. Der nächste Lauf stoppt sie.
func TestReconcileMigrationJournalCleansUpInterruptedMigration(t *testing.T) {
	svc, _, _, l, wfID, activeInstance := setupMigrationWorkflow(t, "", 0)
	stoppedHas := func(id string) bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, s := range l.stopped {
			if s == id {
				return true
			}
		}
		return false
	}
	journal := func(mutate func(*RoleRuntime)) Workflow {
		wf, _ := svc.Get(wfID)
		rt := wf.Runtime["active"]
		at := time.Now().Add(-time.Minute)
		rt.MigrationBy, rt.MigrationNonce, rt.MigrationAt = "", "nonce-of-a-previous-run", &at
		mutate(&rt)
		wf.Runtime["active"] = rt
		if err := svc.store.UpdateRuntime(wf); err != nil {
			t.Fatalf("UpdateRuntime() error = %v", err)
		}
		return wf
	}

	// Nach dem Umschalten abgebrochen: die alte Instanz läuft noch.
	wf := journal(func(rt *RoleRuntime) { rt.MigratedFrom = &RuntimeRef{InstanceID: "old-orphan", HostID: "host-a"} })
	svc.reconcileMigrationJournal(wf)
	waitFor(t, func() bool { return stoppedHas("old-orphan") })
	waitFor(t, func() bool {
		got, _ := svc.Get(wfID)
		return got.Runtime["active"].MigratedFrom == nil && got.Runtime["active"].MigrationBy == ""
	})

	// Vor dem Umschalten abgebrochen: die neue Instanz läuft unreferenziert.
	wf = journal(func(rt *RoleRuntime) { rt.MigratingTo = "new-orphan" })
	svc.reconcileMigrationJournal(wf)
	waitFor(t, func() bool { return stoppedHas("new-orphan") })
	waitFor(t, func() bool {
		got, _ := svc.Get(wfID)
		return got.Runtime["active"].MigratingTo == "" && got.Runtime["active"].InstanceID == activeInstance
	})
	if stoppedHas(activeInstance) {
		t.Fatalf("the instance that serves the role was stopped")
	}

	// Ein frischer Eintrag eines anderen Mitglieds bleibt unangetastet (dort kann der Umzug noch laufen).
	svc.identity = "http://me"
	wf, _ = svc.Get(wfID)
	rt := wf.Runtime["active"]
	now := time.Now()
	rt.MigratingTo, rt.MigrationBy, rt.MigrationNonce, rt.MigrationAt = "in-flight-elsewhere", "http://other", "n", &now
	wf.Runtime["active"] = rt
	_ = svc.store.UpdateRuntime(wf)
	svc.reconcileMigrationJournal(wf)
	time.Sleep(100 * time.Millisecond)
	if stoppedHas("in-flight-elsewhere") {
		t.Fatalf("a migration another member is still running was treated as interrupted")
	}
}

// TestPromoteStandbyFencesOldPrimaryAndRearmsStandby — nach der Übernahme wird die alte Primärinstanz gestoppt
// (Abgrenzung) und ein neuer Standby auf einem anderen Host aufgebaut; die Rolle ist danach wieder failover-fähig.
func TestPromoteStandbyFencesOldPrimaryAndRearmsStandby(t *testing.T) {
	svc, nodes, _, l, wf, activeInstance, standbyInstance := setupRedundantWorkflow(t)
	svc.resources = fixedPlacer{host: "host-b"}

	svc.promoteStandby(wf, "active", "standby", "crash-loop")

	waitFor(t, func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.started) == 4
	})
	l.mu.Lock()
	fenced := false
	for _, id := range l.stopped {
		fenced = fenced || id == activeInstance
	}
	env := l.lastExtraEnv["omp-viewer"]
	l.mu.Unlock()
	if !fenced {
		t.Fatalf("old primary instance was not stopped after the takeover")
	}
	newStandby := l.instanceIDFor("omp-viewer")
	if env[roleSeedEnvKey] == "" || env[roleSeedEnvKey] != withRoleSeed(nil, wf.ID, "active")[roleSeedEnvKey] {
		t.Errorf("new standby must start with the seed of the role whose instance was lost (active), got %q", env[roleSeedEnvKey])
	}
	nodes.add(registry.NodeView{ID: "node-standby-2", InstanceID: newStandby, Receivers: []registry.ReceiverView{{ID: "recv-standby-2"}}})

	waitFor(t, func() bool {
		got, err := svc.Get(wf.ID)
		return err == nil && got.Runtime["standby"].InstanceID == newStandby
	})
	got, _ := svc.Get(wf.ID)
	if a := got.Runtime["active"]; a.InstanceID != standbyInstance || a.StandbyActive || a.SeedRole != "standby" {
		t.Fatalf("active role after rearm = %+v, want it on the promoted instance, failover-capable again", a)
	}
	if sb := got.Runtime["standby"]; sb.HostID != "host-b" || sb.SeedRole != "active" {
		t.Fatalf("standby role after rearm = %+v, want a fresh instance on host-b with the seed of 'active'", sb)
	}

	// Manuell gibt es jetzt nichts mehr wiederherzustellen.
	if err := svc.RearmStandby(context.Background(), wf.ID, "active"); !errors.Is(err, ErrNothingToRearm) {
		t.Fatalf("RearmStandby() on a role with intact redundancy error = %v, want ErrNothingToRearm", err)
	}
}

package workflows

import (
	"testing"
	"time"
)

// TestHostOfflineDetectsHostNeverSeen — fällt ein Host aus, während der Orchestrator neu startet (oder die Führung
// wechselt), hat der neue Prozess nie Telemetrie von ihm gesehen. Auch das muss nach hostOfflineTimeout als Ausfall
// gelten, sonst gäbe es für diesen Host nie ein Failover.
func TestHostOfflineDetectsHostNeverSeen(t *testing.T) {
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)

	if svc.hostOffline("") {
		t.Fatalf("local host must never count as offline")
	}
	if svc.hostOffline("h1") {
		t.Fatalf("unknown host counted as offline on first sight, want a grace period of hostOfflineTimeout")
	}
	svc.hostUnseenMu.Lock()
	svc.hostUnseen["h1"] = time.Now().Add(-2 * hostOfflineTimeout)
	svc.hostUnseenMu.Unlock()
	if !svc.hostOffline("h1") {
		t.Fatalf("host without any telemetry for longer than hostOfflineTimeout must count as offline")
	}

	metrics.set("h1", time.Now())
	if svc.hostOffline("h1") {
		t.Fatalf("host with fresh telemetry counted as offline")
	}
	svc.hostUnseenMu.Lock()
	_, still := svc.hostUnseen["h1"]
	svc.hostUnseenMu.Unlock()
	if still {
		t.Errorf("first-sight marker must be cleared once telemetry arrives")
	}
}

// TestPromoteStandbySkipsStandbyOnOfflineHost — liegt auch der Standby auf einem ausgefallenen Host, darf die Rolle
// nicht auf ihn umgeschrieben werden (sie zeigte sonst auf eine tote Instanz, gemeldet als gelungene Übernahme).
func TestPromoteStandbySkipsStandbyOnOfflineHost(t *testing.T) {
	svc, _, _, _, wf, activeInstance, standbyInstance := setupRedundantWorkflow(t)
	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)

	a, sb := wf.Runtime["active"], wf.Runtime["standby"]
	a.HostID, sb.HostID = "host-a", "host-b"
	wf.Runtime["active"], wf.Runtime["standby"] = a, sb
	if err := svc.store.UpdateRuntime(wf); err != nil {
		t.Fatalf("UpdateRuntime() error = %v", err)
	}
	metrics.set("host-a", time.Now().Add(-2*hostOfflineTimeout))
	metrics.set("host-b", time.Now().Add(-2*hostOfflineTimeout))

	svc.promoteStandby(wf, "active", "standby", "host-offline")
	got, err := svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Runtime["active"].InstanceID != activeInstance {
		t.Fatalf("role was promoted onto a standby whose host is offline: %+v", got.Runtime["active"])
	}

	metrics.set("host-b", time.Now())
	svc.promoteStandby(wf, "active", "standby", "host-offline")
	got, err = svc.Get(wf.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Runtime["active"].InstanceID != standbyInstance || !got.Runtime["active"].StandbyActive {
		t.Fatalf("role not promoted although the standby host is online: %+v", got.Runtime["active"])
	}
}

package workflows

import (
	"testing"
)

func setAPIBase(nodes *fakeNodeLister, nodeID, url string) {
	nodes.mu.Lock()
	defer nodes.mu.Unlock()
	for i := range nodes.nodes {
		if nodes.nodes[i].ID == nodeID {
			nodes.nodes[i].APIBaseURL = url
		}
	}
}

func TestMirrorTargetOnlyForPrimaryWithLiveStandby(t *testing.T) {
	svc, nodes, _, _, _, _, _ := setupRedundantWorkflowLive(t, true)
	setAPIBase(nodes, "node-standby", "http://standby.test")

	if url, ok := svc.MirrorTarget("node-active"); !ok || url != "http://standby.test" {
		t.Fatalf("MirrorTarget(primary) = %q, %v", url, ok)
	}
	if _, ok := svc.MirrorTarget("node-standby"); ok {
		t.Error("the standby itself must not be mirrored")
	}
	if _, ok := svc.MirrorTarget("node-src"); ok {
		t.Error("unrelated node must not be mirrored")
	}
}

func TestMirrorTargetNoneForColdStandby(t *testing.T) {
	svc, nodes, _, _, _, _, _ := setupRedundantWorkflowLive(t, false)
	setAPIBase(nodes, "node-standby", "http://standby.test")
	if _, ok := svc.MirrorTarget("node-active"); ok {
		t.Fatal("cold standby must not receive mirrored commands")
	}
}

func TestMirrorFailedMarksResync(t *testing.T) {
	svc, nodes, _, _, wf, _, _ := setupRedundantWorkflowLive(t, true)
	setAPIBase(nodes, "node-standby", "http://standby.test")
	svc.MirrorTarget("node-active") // füllt den Cache
	svc.MirrorFailed("node-active")
	if _, ok := svc.resyncPending.Load(wf.ID + "|active"); !ok {
		t.Fatal("resync not marked after a failed mirrored command")
	}
}

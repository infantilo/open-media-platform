package workflows

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// kickLauncher ergänzt den fakeLauncher um Kick (harter Neustart-Anstoß).
type kickLauncher struct {
	*fakeLauncher
	kmu    sync.Mutex
	kicked []string
}

func (k *kickLauncher) Kick(id string) error {
	k.kmu.Lock()
	defer k.kmu.Unlock()
	k.kicked = append(k.kicked, id)
	return nil
}

func (k *kickLauncher) kicks() int {
	k.kmu.Lock()
	defer k.kmu.Unlock()
	return len(k.kicked)
}

func setNode(nodes *fakeNodeLister, id string, online bool, api string) {
	nodes.mu.Lock()
	defer nodes.mu.Unlock()
	for i := range nodes.nodes {
		if nodes.nodes[i].ID == id {
			nodes.nodes[i].Online = online
			nodes.nodes[i].APIBaseURL = api
		}
	}
}

func backdateHang(svc *Service, instanceID string) {
	svc.hang.mu.Lock()
	svc.hang.since[instanceID] = time.Now().Add(-2 * defaultHangAfter)
	svc.hang.mu.Unlock()
}

func hangFixture(t *testing.T) (*Service, *fakeNodeLister, *kickLauncher, []Workflow, string, string) {
	t.Helper()
	svc, nodes, _, l, wfID, activeInstance := setupMigrationWorkflow(t, "", 0)
	kl := &kickLauncher{fakeLauncher: l}
	svc.launcher = kl
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	setNode(nodes, "node-src", true, "")
	setNode(nodes, "node-active", true, deadURL)
	wf, _ := svc.Get(wfID)
	wfs := []Workflow{wf}
	svc.checkHungNodes(wfs) // gesund gesehen: Node-API merken
	return svc, nodes, kl, wfs, activeInstance, deadURL
}

// TestHungNodeIsRestartedAfterGracePeriod — Health veraltet UND Node-API tot über die Frist: harter Neustart-Anstoß,
// aber höchstens hangMaxKicks-mal.
func TestHungNodeIsRestartedAfterGracePeriod(t *testing.T) {
	svc, nodes, kl, wfs, activeInstance, deadURL := hangFixture(t)

	setNode(nodes, "node-active", false, deadURL)
	svc.checkHungNodes(wfs) // erste Beobachtung: nur merken
	time.Sleep(30 * time.Millisecond)
	if kl.kicks() != 0 {
		t.Fatalf("hung node was restarted before the grace period")
	}
	for i := 1; i <= hangMaxKicks; i++ {
		backdateHang(svc, activeInstance)
		svc.checkHungNodes(wfs)
		waitFor(t, func() bool { return kl.kicks() == i })
	}
	// Schleifenschutz: kein weiterer Anstoß.
	backdateHang(svc, activeInstance)
	svc.checkHungNodes(wfs)
	time.Sleep(100 * time.Millisecond)
	if kl.kicks() != hangMaxKicks {
		t.Fatalf("kicks = %d, want the loop guard to stop at %d", kl.kicks(), hangMaxKicks)
	}
	svc.hang.mu.Lock()
	gaveUp := svc.hang.gaveUp[activeInstance]
	svc.hang.mu.Unlock()
	if !gaveUp {
		t.Fatalf("loop guard did not record that it gave up")
	}
}

// TestHungNodeNotRestartedWhenAPIAnswers — antwortet die Node-API, lebt der Prozess; es fehlt nur die Meldung am Bus.
func TestHungNodeNotRestartedWhenAPIAnswers(t *testing.T) {
	svc, nodes, kl, wfs, activeInstance, _ := hangFixture(t)
	alive := httptest.NewServer(http.NotFoundHandler())
	defer alive.Close()

	setNode(nodes, "node-active", false, alive.URL)
	svc.checkHungNodes(wfs)
	backdateHang(svc, activeInstance)
	svc.checkHungNodes(wfs)
	time.Sleep(150 * time.Millisecond)
	if kl.kicks() != 0 {
		t.Fatalf("node with a responding API was restarted")
	}
}

// TestHungNodesNoActionWhenMostLookUnhealthy — fallen die meisten Nodes gleichzeitig aus der Überwachung, ist die
// Überwachung gestört; und "aus" (OMP_HANG_ACTION=off) schaltet die Aktion ganz ab.
func TestHungNodesNoActionWhenMostLookUnhealthy(t *testing.T) {
	svc, nodes, kl, wfs, activeInstance, deadURL := hangFixture(t)
	srcInstance := wfs[0].Runtime["src"].InstanceID

	setNode(nodes, "node-active", false, deadURL)
	setNode(nodes, "node-src", false, deadURL)
	svc.checkHungNodes(wfs)
	backdateHang(svc, activeInstance)
	backdateHang(svc, srcInstance)
	svc.checkHungNodes(wfs)
	time.Sleep(100 * time.Millisecond)
	if kl.kicks() != 0 {
		t.Fatalf("nodes were restarted although most of them look unhealthy at once")
	}

	setNode(nodes, "node-src", true, "")
	t.Setenv("OMP_HANG_ACTION", "off")
	backdateHang(svc, activeInstance)
	svc.checkHungNodes(wfs)
	time.Sleep(100 * time.Millisecond)
	if kl.kicks() != 0 {
		t.Fatalf("OMP_HANG_ACTION=off must disable the action")
	}
}

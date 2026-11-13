package workflows

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// TestInstanceRestartedRewiresRoleWithStableNodeID: Workflow-Rollen bekommen einen Rollen-Seed (withRoleSeed) und
// melden sich nach einem automatischen Neustart unter DERSELBEN Node-ID wieder an. Die Neuverkabelung darf dann nicht
// auf "eine andere Node-ID" warten (lief immer in den Timeout), sondern muss den neuen Prozess daran erkennen, dass
// seine Node-API antwortet — und darf den noch gelisteten Eintrag des toten Prozesses nicht dafür halten.
func TestInstanceRestartedRewiresRoleWithStableNodeID(t *testing.T) {
	original, originalPoll := registrationTimeout.Load(), registrationPollInterval.Load()
	registrationTimeout.Store(3 * time.Second)
	registrationPollInterval.Store(10 * time.Millisecond)
	defer func() { registrationTimeout.Store(original); registrationPollInterval.Store(originalPoll) }()

	nodes := &fakeNodeLister{}
	g := &fakeGraph{}
	l := &fakeLauncher{}
	svc := newTestService(newFakeStore(), nodes, g, l)

	def := Definition{
		Roles:       []Role{{Name: "src", NodeType: "omp-source"}, {Name: "view", NodeType: "omp-viewer"}},
		Connections: []Connection{{FromRole: "src", ToRole: "view"}},
	}
	wf, err := svc.Create("regie", def, nil, "")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		n := len(l.started)
		l.mu.Unlock()
		if n == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	srcInstance, viewInstance := l.instanceIDFor("omp-source"), l.instanceIDFor("omp-viewer")
	nodes.add(registry.NodeView{ID: "node-src", InstanceID: srcInstance, Senders: []registry.SenderView{{ID: "send-1"}}})
	nodes.add(registry.NodeView{ID: "node-view", InstanceID: viewInstance, Receivers: []registry.ReceiverView{{ID: "recv-1"}}})
	waitForStatus(t, svc, wf.ID, StatusStarted)
	waitForConnectCalls(g, 1)

	// Der abgestürzte Prozess: sein Registry-Eintrag steht noch, seine Node-API antwortet nicht mehr.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	setAPI := func(url string) {
		nodes.mu.Lock()
		defer nodes.mu.Unlock()
		for i := range nodes.nodes {
			if nodes.nodes[i].ID == "node-src" {
				nodes.nodes[i].APIBaseURL = url
			}
		}
	}
	setAPI(deadURL)
	svc.InstanceRestarted(srcInstance)

	time.Sleep(200 * time.Millisecond)
	g.mu.Lock()
	early := len(g.calls)
	g.mu.Unlock()
	if early != 1 {
		t.Fatalf("connect calls while only the dead registration is listed = %d, want 1 (stale entry must not count as restarted)", early)
	}

	// Der neue Prozess registriert sich unter derselben Node-ID mit neuer Adresse.
	alive := httptest.NewServer(http.NotFoundHandler())
	defer alive.Close()
	setAPI(alive.URL)

	waitForConnectCalls(g, 2)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.calls) != 2 {
		t.Fatalf("connect calls after restart with unchanged node id = %+v, want the connection re-applied", g.calls)
	}
	if g.calls[1].fromSender != "send-1" || g.calls[1].toReceiver != "recv-1" {
		t.Errorf("second connect call = %+v, want send-1 -> recv-1", g.calls[1])
	}
}

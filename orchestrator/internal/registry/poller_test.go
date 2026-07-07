package registry

import (
	"testing"
	"time"
)

type fakeHealthChecker struct{ stale map[string]bool }

func (f fakeHealthChecker) IsStale(nodeID string, _ time.Duration) bool {
	return f.stale[nodeID]
}

type change struct {
	eventType string
	nodeID    string
}

func TestNotifyChangesAdded(t *testing.T) {
	p := NewPoller(nil, nil)
	var got []change
	p.OnChange = func(eventType string, n NodeView) {
		got = append(got, change{eventType, n.ID})
	}

	p.notifyChanges([]NodeView{{ID: "node-1", Label: "Node 1"}})

	if len(got) != 1 || got[0] != (change{"node.added", "node-1"}) {
		t.Fatalf("got %+v, want one node.added for node-1", got)
	}
}

func TestNotifyChangesUpdated(t *testing.T) {
	p := NewPoller(nil, nil)
	p.OnChange = func(string, NodeView) {}
	p.notifyChanges([]NodeView{{ID: "node-1", Label: "Node 1"}})

	var got []change
	p.OnChange = func(eventType string, n NodeView) {
		got = append(got, change{eventType, n.ID})
	}
	p.notifyChanges([]NodeView{{ID: "node-1", Label: "Node 1 renamed"}})

	if len(got) != 1 || got[0] != (change{"node.updated", "node-1"}) {
		t.Fatalf("got %+v, want one node.updated for node-1", got)
	}
}

func TestNotifyChangesRemoved(t *testing.T) {
	p := NewPoller(nil, nil)
	p.OnChange = func(string, NodeView) {}
	p.notifyChanges([]NodeView{{ID: "node-1", Label: "Node 1"}})

	var got []change
	p.OnChange = func(eventType string, n NodeView) {
		got = append(got, change{eventType, n.ID})
	}
	p.notifyChanges([]NodeView{})

	if len(got) != 1 || got[0] != (change{"node.removed", "node-1"}) {
		t.Fatalf("got %+v, want one node.removed for node-1", got)
	}
}

func TestNotifyChangesUnchangedNodeProducesNoEvent(t *testing.T) {
	p := NewPoller(nil, nil)
	p.OnChange = func(string, NodeView) {}
	node := NodeView{ID: "node-1", Label: "Node 1"}
	p.notifyChanges([]NodeView{node})

	var got []change
	p.OnChange = func(eventType string, n NodeView) {
		got = append(got, change{eventType, n.ID})
	}
	p.notifyChanges([]NodeView{node})

	if len(got) != 0 {
		t.Fatalf("got %+v, want no events for unchanged node", got)
	}
}

func TestApplyHealthStalenessMarksOfflineOnStaleHealth(t *testing.T) {
	p := NewPoller(nil, nil)
	p.HealthTracker = fakeHealthChecker{stale: map[string]bool{"node-1": true}}
	p.HealthStaleAfter = 10 * time.Second

	nodes := []NodeView{{ID: "node-1", Online: true}}
	p.applyHealthStaleness(nodes)

	if nodes[0].Online {
		t.Error("Online = true, want false for node with stale health")
	}
}

func TestApplyHealthStalenessLeavesFreshNodesOnline(t *testing.T) {
	p := NewPoller(nil, nil)
	p.HealthTracker = fakeHealthChecker{stale: map[string]bool{}}
	p.HealthStaleAfter = 10 * time.Second

	nodes := []NodeView{{ID: "node-1", Online: true}}
	p.applyHealthStaleness(nodes)

	if !nodes[0].Online {
		t.Error("Online = false, want true for node with fresh health")
	}
}

func TestApplyHealthStalenessDisabledWithoutTracker(t *testing.T) {
	p := NewPoller(nil, nil)
	nodes := []NodeView{{ID: "node-1", Online: true}}
	p.applyHealthStaleness(nodes)

	if !nodes[0].Online {
		t.Error("Online = false, want true when no HealthTracker configured")
	}
}

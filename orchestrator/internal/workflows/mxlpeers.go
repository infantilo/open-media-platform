package workflows

import (
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// mxlPeerConflict prüft vor dem Umzug einer Rolle, ob ihr Node über MXL mit Nodes auf einem ANDEREN Host verbunden ist als dem
// Zielhost. MXL ist host-lokal (geteilter Speicher): zöge die Rolle um, bliebe die Gegenstelle ohne Signal stehen (Bild friert ein),
// und die Verbindung wird auch nicht neu aufgebaut, wenn sie nicht Teil der Workflow-Definition ist. Liefert die Beschriftung der
// ersten betroffenen Gegenstelle. instHost bildet Instanz-ID → Host-ID ("" = Orchestrator-Host) ab.
func mxlPeerConflict(nodes []registry.NodeView, edges []graph.Edge, instHost map[string]string, oldNodeID, targetHost string) (string, bool) {
	type portInfo struct {
		node      *registry.NodeView
		transport string
	}
	ports := map[string]portInfo{}
	for i := range nodes {
		n := &nodes[i]
		for _, s := range n.Senders {
			ports[s.ID] = portInfo{node: n, transport: s.Transport}
		}
		for _, r := range n.Receivers {
			ports[r.ID] = portInfo{node: n}
		}
	}
	hostOf := func(n *registry.NodeView) string {
		if n.InstanceID == "" {
			return "?" // keine Instanz bekannt: Host unbekannt, nicht als Konflikt werten
		}
		return instHost[n.InstanceID]
	}
	for _, e := range edges {
		from, okF := ports[e.FromSender]
		to, okT := ports[e.ToReceiver]
		if !okF || !okT || !strings.Contains(strings.ToLower(from.transport), "mxl") {
			continue
		}
		var peer *registry.NodeView
		switch oldNodeID {
		case from.node.ID:
			peer = to.node
		case to.node.ID:
			peer = from.node
		default:
			continue
		}
		if h := hostOf(peer); h != "?" && h != targetHost {
			return peer.Label, true
		}
	}
	return "", false
}

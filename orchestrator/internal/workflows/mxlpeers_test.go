package workflows

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func TestMXLGegenstelleAufAnderemHost(t *testing.T) {
	nodes := []registry.NodeView{
		{ID: "src", Label: "Quelle", InstanceID: "i1", Senders: []registry.SenderView{{ID: "s1", Transport: "urn:x-nmos:transport:mxl"}}},
		{ID: "vw", Label: "Viewer", InstanceID: "i2", Receivers: []registry.ReceiverView{{ID: "r1"}}},
		{ID: "ext", Label: "Extern", Receivers: []registry.ReceiverView{{ID: "r2"}}},
		{ID: "rtp", Label: "RTP-Quelle", InstanceID: "i1", Senders: []registry.SenderView{{ID: "s2", Transport: "urn:x-nmos:transport:rtp"}}},
	}
	edges := []graph.Edge{{ID: "r1", FromSender: "s1", ToReceiver: "r1"}}
	hosts := map[string]string{"i1": "hostC", "i2": ""} // Viewer läuft auf dem Orchestrator-Host
	if peer, bad := mxlPeerConflict(nodes, edges, hosts, nil, "src", "hostA"); !bad || peer != "Viewer" {
		t.Fatalf("Umzug auf A trennt die MXL-Verbindung zum lokalen Viewer: %q %v", peer, bad)
	}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, nil, "src", ""); bad {
		t.Fatal("Umzug auf den Host der Gegenstelle ist unproblematisch")
	}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, nil, "vw", "hostC"); bad {
		t.Fatal("Umzug des Viewers auf den Host der Quelle ist unproblematisch")
	}
	if _, bad := mxlPeerConflict(nodes, []graph.Edge{{ID: "r2", FromSender: "s1", ToReceiver: "r2"}}, hosts, nil, "src", "hostA"); bad {
		t.Fatal("Gegenstelle ohne Instanz: Host unbekannt, kein Konflikt")
	}
	if _, bad := mxlPeerConflict(nodes, []graph.Edge{{ID: "r1", FromSender: "s2", ToReceiver: "r1"}}, hosts, nil, "rtp", "hostA"); bad {
		t.Fatal("Netzwerk-Transport ist hostübergreifend möglich")
	}
}

func TestMxlPeerConflictIgnoresPeersOfPlannedGroupMove(t *testing.T) {
	nodes := []registry.NodeView{
		{ID: "src", Label: "Source", InstanceID: "i-src", Senders: []registry.SenderView{{ID: "s1", Transport: "urn:x-nmos:transport:mxl"}}},
		{ID: "vw", Label: "Viewer", InstanceID: "i-vw", Receivers: []registry.ReceiverView{{ID: "r1"}}},
	}
	edges := []graph.Edge{{ID: "e", FromSender: "s1", ToReceiver: "r1"}}
	hosts := map[string]string{"i-src": "hostA", "i-vw": "hostA"}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, nil, "src", "hostB"); !bad {
		t.Fatal("ohne Plan: Konflikt")
	}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, map[string]bool{"i-vw": true}, "src", "hostB"); bad {
		t.Fatal("Gegenstelle gehört zum geplanten Verbund-Umzug: kein Konflikt")
	}
}

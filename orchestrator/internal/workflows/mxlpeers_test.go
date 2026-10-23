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
	if peer, bad := mxlPeerConflict(nodes, edges, hosts, "src", "hostA"); !bad || peer != "Viewer" {
		t.Fatalf("Umzug auf A trennt die MXL-Verbindung zum lokalen Viewer: %q %v", peer, bad)
	}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, "src", ""); bad {
		t.Fatal("Umzug auf den Host der Gegenstelle ist unproblematisch")
	}
	if _, bad := mxlPeerConflict(nodes, edges, hosts, "vw", "hostC"); bad {
		t.Fatal("Umzug des Viewers auf den Host der Quelle ist unproblematisch")
	}
	if _, bad := mxlPeerConflict(nodes, []graph.Edge{{ID: "r2", FromSender: "s1", ToReceiver: "r2"}}, hosts, "src", "hostA"); bad {
		t.Fatal("Gegenstelle ohne Instanz: Host unbekannt, kein Konflikt")
	}
	if _, bad := mxlPeerConflict(nodes, []graph.Edge{{ID: "r1", FromSender: "s2", ToReceiver: "r1"}}, hosts, "rtp", "hostA"); bad {
		t.Fatal("Netzwerk-Transport ist hostübergreifend möglich")
	}
}

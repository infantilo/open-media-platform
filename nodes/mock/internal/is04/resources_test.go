package is04

import (
	"regexp"
	"testing"
)

var macPattern = regexp.MustCompile(`^([0-9a-f]{2}-){5}([0-9a-f]{2})$`)

func TestNewNodeHasValidInterface(t *testing.T) {
	n := NewNode("node-1", "Mock", "127.0.0.1", 9001)

	if len(n.Interfaces) != 1 {
		t.Fatalf("len(Interfaces) = %d, want 1", len(n.Interfaces))
	}
	iface := n.Interfaces[0]
	if !macPattern.MatchString(iface.PortID) {
		t.Errorf("PortID = %q, does not match MAC pattern", iface.PortID)
	}
	if iface.ChassisID != nil {
		t.Errorf("ChassisID = %v, want nil", iface.ChassisID)
	}
	if len(n.API.Endpoints) != 1 || n.API.Endpoints[0].Port != 9001 {
		t.Errorf("API.Endpoints = %+v, want one endpoint on port 9001", n.API.Endpoints)
	}
}

func TestNewDeviceReferencesNodeAndChildren(t *testing.T) {
	d := NewDevice("dev-1", "Mock Device", "node-1", []string{"send-1"}, []string{"recv-1"})

	if d.NodeID != "node-1" {
		t.Errorf("NodeID = %q, want node-1", d.NodeID)
	}
	if len(d.Senders) != 1 || d.Senders[0] != "send-1" {
		t.Errorf("Senders = %v, want [send-1]", d.Senders)
	}
	if len(d.Receivers) != 1 || d.Receivers[0] != "recv-1" {
		t.Errorf("Receivers = %v, want [recv-1]", d.Receivers)
	}
}

func TestNewSenderHasNilFlowAndDeviceReference(t *testing.T) {
	s := NewSender("send-1", "Mock Sender", "dev-1")

	if s.DeviceID != "dev-1" {
		t.Errorf("DeviceID = %q, want dev-1", s.DeviceID)
	}
	if s.FlowID != nil {
		t.Errorf("FlowID = %v, want nil (no flow registered by mock node)", s.FlowID)
	}
	if s.Transport != transportRTP {
		t.Errorf("Transport = %q, want %q", s.Transport, transportRTP)
	}
}

func TestNewReceiverHasFormatAndDeviceReference(t *testing.T) {
	r := NewReceiver("recv-1", "Mock Receiver", "dev-1")

	if r.DeviceID != "dev-1" {
		t.Errorf("DeviceID = %q, want dev-1", r.DeviceID)
	}
	if r.Format != formatVideo {
		t.Errorf("Format = %q, want %q", r.Format, formatVideo)
	}
	if len(r.Caps.MediaTypes) == 0 {
		t.Error("Caps.MediaTypes should not be empty")
	}
}

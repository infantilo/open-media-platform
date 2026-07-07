package registry

import "testing"

func strPtr(s string) *string { return &s }

func TestBuildSnapshotAssemblesHierarchy(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Node 1"}}
	devices := []is04Device{{ID: "dev-1", Label: "Device 1", NodeID: "node-1"}}
	senders := []is04Sender{{ID: "send-1", Label: "Sender 1", DeviceID: "dev-1", FlowID: strPtr("flow-1")}}
	receivers := []is04Receiver{{ID: "recv-1", Label: "Receiver 1", DeviceID: "dev-1", Format: "urn:x-nmos:format:video"}}
	flows := []is04Flow{{ID: "flow-1", Format: "urn:x-nmos:format:video"}}

	views := buildSnapshot(nodes, devices, senders, receivers, flows)

	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want 1", len(views))
	}
	v := views[0]
	if v.ID != "node-1" || v.Label != "Node 1" {
		t.Errorf("node id/label = %q/%q, want node-1/Node 1", v.ID, v.Label)
	}
	if !v.Online {
		t.Error("expected node to be marked online")
	}
	if len(v.Devices) != 1 || v.Devices[0].ID != "dev-1" {
		t.Errorf("devices = %+v, want one device dev-1", v.Devices)
	}
	if len(v.Senders) != 1 || v.Senders[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("senders = %+v, want one sender with resolved flow format", v.Senders)
	}
	if len(v.Receivers) != 1 || v.Receivers[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("receivers = %+v, want one receiver with format", v.Receivers)
	}
}

func TestBuildSnapshotSenderWithoutFlowHasEmptyFormat(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Node 1"}}
	devices := []is04Device{{ID: "dev-1", NodeID: "node-1"}}
	senders := []is04Sender{{ID: "send-1", DeviceID: "dev-1", FlowID: nil}}

	views := buildSnapshot(nodes, devices, senders, nil, nil)

	if len(views[0].Senders) != 1 {
		t.Fatalf("expected one sender")
	}
	if views[0].Senders[0].Format != "" {
		t.Errorf("format = %q, want empty (no flow registered)", views[0].Senders[0].Format)
	}
}

func TestBuildSnapshotNodeWithoutDevicesHasEmptySlices(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Lonely Node"}}

	views := buildSnapshot(nodes, nil, nil, nil, nil)

	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want 1", len(views))
	}
	if views[0].Devices == nil || len(views[0].Devices) != 0 {
		t.Errorf("Devices = %v, want empty non-nil slice", views[0].Devices)
	}
	if views[0].Senders == nil || len(views[0].Senders) != 0 {
		t.Errorf("Senders = %v, want empty non-nil slice", views[0].Senders)
	}
}

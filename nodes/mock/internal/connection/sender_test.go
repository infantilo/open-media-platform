package connection

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// receiverIDSet builds the "receiver_id explicitly present" case (either a
// real ID or, with nil, an explicit disconnect) — see OptionalReceiverID.
func receiverIDSet(id *string) OptionalReceiverID { return OptionalReceiverID{Set: true, Value: id} }

func TestNewSenderStoreStartsUnconnected(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})

	active, ok := s.Active("send-1")
	if !ok {
		t.Fatal("Active(send-1) ok = false, want true")
	}
	if active.ReceiverID != nil {
		t.Errorf("ReceiverID = %v, want nil", active.ReceiverID)
	}
	// examples/sender-active-get-uninit.json (AMWA-TV/is-05 v1.1.2):
	// master_enable ist im UNINIT-Beispiel bereits true, und active zeigt
	// von Anfang an konkret aufgelöste Werte, kein "auto".
	if !active.MasterEnable {
		t.Errorf("uninit active MasterEnable = false, want true (sender-active-get-uninit.json)")
	}
	for k, v := range active.TransportParams[0] {
		if str, ok := v.(string); ok && str == "auto" {
			t.Errorf("active default transport_params[%q] = %q, want a resolved concrete value, not \"auto\"", k, str)
		}
	}

	staged, _ := s.Staged("send-1")
	if staged.TransportParams[0]["destination_port"] != "auto" {
		t.Errorf("staged default destination_port = %v, want the spec-uninit \"auto\" placeholder to survive", staged.TransportParams[0]["destination_port"])
	}
	// Sender-Feldmenge, KEIN interface_ip/multicast_ip (Receiver-only) —
	// s. sender.go-Moduldoku.
	for _, forbidden := range []string{"interface_ip", "multicast_ip"} {
		if _, ok := staged.TransportParams[0][forbidden]; ok {
			t.Errorf("sender transport_params contains receiver-only field %q, sender_transport_params_rtp.json disallows it (additionalProperties:false)", forbidden)
		}
	}
}

func TestSenderPatchStagedWithImmediateActivationUpdatesActive(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})

	req := SenderPatchRequest{
		ReceiverID:   receiverIDSet(strPtr("recv-1")),
		MasterEnable: boolPtr(true),
		Activation:   &Activation{Mode: strPtr("activate_immediate")},
	}
	updated, _, ok := s.PatchStaged("send-1", req)
	if !ok {
		t.Fatal("PatchStaged ok = false, want true")
	}
	if updated.ReceiverID == nil || *updated.ReceiverID != "recv-1" {
		t.Fatalf("staged ReceiverID = %v, want recv-1", updated.ReceiverID)
	}
	if updated.Activation.ActivationTime == nil {
		t.Fatal("PATCH response ActivationTime = nil, want a real timestamp")
	}

	active, _ := s.Active("send-1")
	if active.ReceiverID == nil || *active.ReceiverID != "recv-1" {
		t.Fatalf("active ReceiverID = %v, want recv-1", active.ReceiverID)
	}

	staged, _ := s.Staged("send-1")
	if staged.Activation.Mode != nil {
		t.Fatalf("staged Activation.Mode after activation = %v, want nil (reset)", staged.Activation.Mode)
	}
}

func TestSenderPatchStagedDisconnect(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})
	s.PatchStaged("send-1", SenderPatchRequest{
		ReceiverID: receiverIDSet(strPtr("recv-1")), MasterEnable: boolPtr(true),
		Activation: &Activation{Mode: strPtr("activate_immediate")},
	})

	s.PatchStaged("send-1", SenderPatchRequest{
		ReceiverID: receiverIDSet(nil), MasterEnable: boolPtr(false),
		Activation: &Activation{Mode: strPtr("activate_immediate")},
	})

	active, _ := s.Active("send-1")
	if active.ReceiverID != nil {
		t.Fatalf("active ReceiverID after disconnect = %v, want nil", active.ReceiverID)
	}
}

func TestSenderPatchStagedFieldOmittedLeavesItUnchanged(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})
	s.PatchStaged("send-1", SenderPatchRequest{
		ReceiverID: receiverIDSet(strPtr("recv-1")), MasterEnable: boolPtr(true),
	})

	updated, _, _ := s.PatchStaged("send-1", SenderPatchRequest{MasterEnable: boolPtr(false)})
	if updated.ReceiverID == nil || *updated.ReceiverID != "recv-1" {
		t.Fatalf("ReceiverID after omitted-field PATCH = %v, want unchanged recv-1", updated.ReceiverID)
	}
	if updated.MasterEnable != false {
		t.Fatalf("MasterEnable = %v, want false", updated.MasterEnable)
	}
}

func TestSenderPatchStagedMergesTransportParamsLeg(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})

	s.PatchStaged("send-1", SenderPatchRequest{
		TransportParams: []map[string]any{{"destination_port": 6000}},
	})
	updated, _, _ := s.PatchStaged("send-1", SenderPatchRequest{
		TransportParams: []map[string]any{{"rtp_enabled": false}},
	})

	leg := updated.TransportParams[0]
	if leg["destination_port"] != 6000 {
		t.Fatalf("destination_port after second PATCH = %v, want 6000 (merge, not replace)", leg["destination_port"])
	}
	if leg["rtp_enabled"] != false {
		t.Fatalf("rtp_enabled = %v, want false", leg["rtp_enabled"])
	}
	if leg["source_ip"] != "auto" {
		t.Fatalf("source_ip = %v, want default \"auto\" to survive untouched", leg["source_ip"])
	}
}

func TestSenderPatchStagedScheduledRelativeActivationFiresLater(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})

	response, status, ok := s.PatchStaged("send-1", SenderPatchRequest{
		ReceiverID:   receiverIDSet(strPtr("recv-1")),
		MasterEnable: boolPtr(true),
		Activation: &Activation{
			Mode:          strPtr("activate_scheduled_relative"),
			RequestedTime: strPtr("0:50000000"), // 50ms
		},
	})
	if !ok || status != http.StatusAccepted {
		t.Fatalf("status = %d, ok = %v, want 202/true", status, ok)
	}
	if response.Activation.ActivationTime == nil {
		t.Fatal("PATCH response ActivationTime for a scheduled activation = nil, want the precomputed target timestamp")
	}

	active, _ := s.Active("send-1")
	if active.ReceiverID != nil {
		t.Fatalf("active ReceiverID immediately after scheduling = %v, want nil (not yet fired)", active.ReceiverID)
	}

	time.Sleep(150 * time.Millisecond)

	active, _ = s.Active("send-1")
	if active.ReceiverID == nil || *active.ReceiverID != "recv-1" {
		t.Fatalf("active ReceiverID after the scheduled delay = %v, want recv-1 (timer should have fired)", active.ReceiverID)
	}
}

func TestSenderPatchStagedScheduledAbsoluteActivationUsesTaiOffset(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})

	targetUTC := time.Now().Add(100 * time.Millisecond)
	taiSeconds := targetUTC.Unix() + taiUtcOffsetSeconds

	_, status, ok := s.PatchStaged("send-1", SenderPatchRequest{
		ReceiverID:   receiverIDSet(strPtr("recv-1")),
		MasterEnable: boolPtr(true),
		Activation: &Activation{
			Mode:          strPtr("activate_scheduled_absolute"),
			RequestedTime: strPtr(fmt.Sprintf("%d:%d", taiSeconds, targetUTC.Nanosecond())),
		},
	})
	if !ok || status != http.StatusAccepted {
		t.Fatalf("status = %d, ok = %v, want 202/true", status, ok)
	}

	time.Sleep(300 * time.Millisecond)

	active, _ := s.Active("send-1")
	if active.ReceiverID == nil || *active.ReceiverID != "recv-1" {
		t.Fatalf("active ReceiverID after the TAI-based absolute schedule = %v, want recv-1 (timer fired too late — TAI/UTC offset bug)", active.ReceiverID)
	}
}

func TestSenderPatchStagedUnknownSenderReturnsFalse(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})
	_, _, ok := s.PatchStaged("does-not-exist", SenderPatchRequest{})
	if ok {
		t.Fatal("PatchStaged(unknown) ok = true, want false")
	}
}

// TestSenderTransportFileBuildsParseableSDP — `auto_connection_*` (der
// eigentliche Grund für die Sender-Fixture, s. handler.go-Moduldoku)
// braucht eine gültige SDP mit der aufgelösten Zieladresse/-port, nicht
// nur irgendeinen Text.
func TestSenderTransportFileBuildsParseableSDP(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})
	s.PatchStaged("send-1", SenderPatchRequest{
		TransportParams: []map[string]any{{"destination_ip": "239.1.1.1", "destination_port": 6004}},
		Activation:      &Activation{Mode: strPtr("activate_immediate")},
	})

	sdp, ok := s.TransportFile("send-1")
	if !ok {
		t.Fatal("TransportFile ok = false, want true")
	}
	if !strings.HasPrefix(sdp, "v=0\r\n") {
		t.Fatalf("SDP does not start with v=0: %q", sdp)
	}
	if !strings.Contains(sdp, "c=IN IP4 239.1.1.1") {
		t.Fatalf("SDP missing resolved destination_ip in c= line: %q", sdp)
	}
	if !strings.Contains(sdp, "m=video 6004 RTP/AVP 96") {
		t.Fatalf("SDP missing resolved destination_port in m= line: %q", sdp)
	}
}

func TestSenderTransportFileUnknownSenderReturnsFalse(t *testing.T) {
	s := NewSenderStore([]string{"send-1"})
	_, ok := s.TransportFile("does-not-exist")
	if ok {
		t.Fatal("TransportFile(unknown) ok = true, want false")
	}
}

// TestSenderConstraintsFieldSet — Feldliste exakt aus
// examples/sender-constraints-get-200.json (AMWA-TV/is-05 v1.1.2), KEIN
// interface_ip/multicast_ip (die stehen dort nicht, anders als bei
// Receivern).
func TestSenderConstraintsFieldSet(t *testing.T) {
	constraints := SenderConstraints()
	if len(constraints) != 1 {
		t.Fatalf("constraints legs = %d, want 1", len(constraints))
	}
	want := []string{
		"source_ip", "destination_ip", "source_port", "destination_port",
		"fec_enabled", "fec_destination_ip", "fec_type", "fec_mode",
		"fec_block_width", "fec_block_height", "fec1D_destination_port",
		"fec2D_destination_port", "fec1D_source_port", "fec2D_source_port",
		"rtcp_enabled", "rtcp_destination_ip", "rtcp_destination_port",
		"rtcp_source_port", "rtp_enabled",
	}
	for _, field := range want {
		if _, ok := constraints[0][field]; !ok {
			t.Errorf("constraints missing field %q", field)
		}
	}
	if len(constraints[0]) != len(want) {
		t.Errorf("constraints has %d fields, want exactly %d (no receiver-only extras)", len(constraints[0]), len(want))
	}
	for _, forbidden := range []string{"interface_ip", "multicast_ip"} {
		if _, ok := constraints[0][forbidden]; ok {
			t.Errorf("constraints contains receiver-only field %q", forbidden)
		}
	}
}

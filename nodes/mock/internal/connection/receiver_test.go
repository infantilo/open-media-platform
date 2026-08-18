package connection

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// senderIDSet builds the "sender_id explicitly present" case (either a
// real ID or, with nil, an explicit disconnect) — see OptionalSenderID.
func senderIDSet(id *string) OptionalSenderID { return OptionalSenderID{Set: true, Value: id} }

func TestNewReceiverStoreStartsUnconnected(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	active, ok := s.Active("recv-1")
	if !ok {
		t.Fatal("Active(recv-1) ok = false, want true")
	}
	if active.SenderID != nil {
		t.Errorf("SenderID = %v, want nil", active.SenderID)
	}
	// Live an AMWA-test_12_01 gefunden (docs/decisions.md): active's
	// uninitialisierter Default darf kein "auto" zeigen (nur staged
	// darf das) — das AMWA-Referenzbeispiel receiver-active-get-200-
	// uninit.json bestätigt konkrete, aufgelöste Werte von Anfang an.
	for k, v := range active.TransportParams[0] {
		if s, ok := v.(string); ok && s == "auto" {
			t.Errorf("active default transport_params[%q] = %q, want a resolved concrete value, not \"auto\"", k, s)
		}
	}
	staged, _ := s.Staged("recv-1")
	if staged.TransportParams[0]["destination_port"] != "auto" {
		t.Errorf("staged default destination_port = %v, want the spec-uninit \"auto\" placeholder to survive", staged.TransportParams[0]["destination_port"])
	}
}

func TestPatchStagedWithImmediateActivationUpdatesActive(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	req := PatchRequest{
		SenderID:     senderIDSet(strPtr("sender-1")),
		MasterEnable: boolPtr(true),
		Activation:   &Activation{Mode: strPtr("activate_immediate")},
	}
	updated, _, ok := s.PatchStaged("recv-1", req)
	if !ok {
		t.Fatal("PatchStaged ok = false, want true")
	}
	if updated.SenderID == nil || *updated.SenderID != "sender-1" {
		t.Fatalf("staged SenderID = %v, want sender-1", updated.SenderID)
	}
	if updated.Activation.Mode == nil || *updated.Activation.Mode != "activate_immediate" {
		t.Fatalf("PATCH response Activation.Mode = %v, want activate_immediate", updated.Activation.Mode)
	}
	if updated.Activation.ActivationTime == nil {
		t.Fatal("PATCH response Activation.ActivationTime = nil, want a real timestamp")
	}

	active, _ := s.Active("recv-1")
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active SenderID = %v, want sender-1", active.SenderID)
	}
	if active.Activation.Mode == nil || *active.Activation.Mode != "activate_immediate" {
		t.Fatalf("active Activation.Mode = %v, want activate_immediate to persist", active.Activation.Mode)
	}

	// Staged persists with activation reset to null — only the PATCH
	// response itself showed the transient activate_immediate moment.
	staged, _ := s.Staged("recv-1")
	if staged.Activation.Mode != nil {
		t.Fatalf("staged Activation.Mode after activation = %v, want nil (reset)", staged.Activation.Mode)
	}
	if staged.Activation.ActivationTime != nil {
		t.Fatalf("staged Activation.ActivationTime after activation = %v, want nil (reset)", staged.Activation.ActivationTime)
	}
}

func TestPatchStagedWithoutActivationDoesNotUpdateActive(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	s.PatchStaged("recv-1", PatchRequest{SenderID: senderIDSet(strPtr("sender-1")), MasterEnable: boolPtr(true)})

	active, _ := s.Active("recv-1")
	if active.SenderID != nil {
		t.Fatalf("active SenderID = %v, want nil (no activation requested)", active.SenderID)
	}
}

func TestPatchStagedDisconnect(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})
	s.PatchStaged("recv-1", PatchRequest{
		SenderID: senderIDSet(strPtr("sender-1")), MasterEnable: boolPtr(true),
		Activation: &Activation{Mode: strPtr("activate_immediate")},
	})

	s.PatchStaged("recv-1", PatchRequest{
		SenderID: senderIDSet(nil), MasterEnable: boolPtr(false),
		Activation: &Activation{Mode: strPtr("activate_immediate")},
	})

	active, _ := s.Active("recv-1")
	if active.SenderID != nil {
		t.Fatalf("active SenderID after disconnect = %v, want nil", active.SenderID)
	}
}

// TestPatchStagedFieldOmittedLeavesItUnchanged — live gefundener Bug
// (docs/decisions.md D11): eine naive `*string`-Fassung von SenderID
// konnte "im Body fehlend" nicht von "im Body auf null gesetzt"
// unterscheiden. Dieser Test verankert genau diese Unterscheidung: ein
// PATCH, das `sender_id` gar nicht erwähnt, darf eine bereits
// verbundene Quelle NICHT trennen.
func TestPatchStagedFieldOmittedLeavesItUnchanged(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})
	s.PatchStaged("recv-1", PatchRequest{
		SenderID: senderIDSet(strPtr("sender-1")), MasterEnable: boolPtr(true),
	})

	// sender_id absichtlich NICHT gesetzt (Set: false) — nur
	// master_enable ändert sich.
	updated, _, _ := s.PatchStaged("recv-1", PatchRequest{MasterEnable: boolPtr(false)})
	if updated.SenderID == nil || *updated.SenderID != "sender-1" {
		t.Fatalf("SenderID after omitted-field PATCH = %v, want unchanged sender-1", updated.SenderID)
	}
	if updated.MasterEnable != false {
		t.Fatalf("MasterEnable = %v, want false", updated.MasterEnable)
	}
}

// TestPatchStagedMergesTransportParamsLeg — live an AMWA-test_24/26/28/30
// gefunden: ein PATCH, der nur destination_port nennt, darf die übrigen
// bereits gesetzten Leg-Felder nicht verwerfen.
func TestPatchStagedMergesTransportParamsLeg(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	s.PatchStaged("recv-1", PatchRequest{
		TransportParams: []map[string]any{{"destination_port": 5000}},
	})
	updated, _, _ := s.PatchStaged("recv-1", PatchRequest{
		TransportParams: []map[string]any{{"rtp_enabled": true}},
	})

	leg := updated.TransportParams[0]
	if leg["destination_port"] != 5000 {
		t.Fatalf("destination_port after second PATCH = %v, want 5000 (merge, not replace)", leg["destination_port"])
	}
	if leg["rtp_enabled"] != true {
		t.Fatalf("rtp_enabled = %v, want true", leg["rtp_enabled"])
	}
	// Fields never touched by any PATCH keep their spec-mandated default
	// (receiver-get-200-uninit.json), not vanish entirely.
	if leg["interface_ip"] != "auto" {
		t.Fatalf("interface_ip = %v, want default \"auto\" to survive untouched", leg["interface_ip"])
	}
}

// TestPatchStagedScheduledRelativeActivationFiresLater — live an
// AMWA-test_28/test_30 gefunden: eine geplante Aktivierung muss
// tatsächlich zum angeforderten Zeitpunkt eintreten, nicht nur mit 202
// akzeptiert und danach nie ausgeführt werden.
func TestPatchStagedScheduledRelativeActivationFiresLater(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	response, status, ok := s.PatchStaged("recv-1", PatchRequest{
		SenderID:     senderIDSet(strPtr("sender-1")),
		MasterEnable: boolPtr(true),
		Activation: &Activation{
			Mode:          strPtr("activate_scheduled_relative"),
			RequestedTime: strPtr("0:50000000"), // 50ms
		},
	})
	if !ok || status != http.StatusAccepted {
		t.Fatalf("status = %d, ok = %v, want 202/true", status, ok)
	}
	// Live an AMWA-test_28/test_30 gefunden: activation_time muss SOFORT
	// in der PATCH-Antwort einen echten Zeitstempel zeigen (der
	// vorausberechnete Ziel-Zeitpunkt), nicht erst wenn der Timer feuert
	// — der Schema-Text sagt ausdrücklich "will ... activate".
	if response.Activation.ActivationTime == nil {
		t.Fatal("PATCH response ActivationTime for a scheduled activation = nil, want the precomputed target timestamp")
	}

	active, _ := s.Active("recv-1")
	if active.SenderID != nil {
		t.Fatalf("active SenderID immediately after scheduling = %v, want nil (not yet fired)", active.SenderID)
	}

	time.Sleep(150 * time.Millisecond)

	active, _ = s.Active("recv-1")
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active SenderID after the scheduled delay = %v, want sender-1 (timer should have fired)", active.SenderID)
	}
	if active.Activation.Mode == nil || *active.Activation.Mode != "activate_scheduled_relative" {
		t.Fatalf("active Activation.Mode = %v, want activate_scheduled_relative to persist", active.Activation.Mode)
	}

	staged, _ := s.Staged("recv-1")
	if staged.Activation.Mode != nil {
		t.Fatalf("staged Activation.Mode after firing = %v, want nil (reset like immediate activation)", staged.Activation.Mode)
	}
}

// TestPatchStagedScheduledAbsoluteActivationUsesTaiOffset — live an
// AMWA-test_30 gefunden: `requested_time` für `activate_scheduled_
// absolute` ist echte TAI (37s vor UTC, AMWA-TV/nmos-testing
// `NMOSUtils.get_TAI_time`), nicht Unix-Zeit — ohne den Abzug feuerte
// die Aktivierung ~37s zu spät.
func TestPatchStagedScheduledAbsoluteActivationUsesTaiOffset(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	// "In 100ms" ausgedrückt als TAI (UTC + 37s + 100ms) — genau wie
	// `NMOSUtils.get_TAI_time(0.1)` das täte.
	targetUTC := time.Now().Add(100 * time.Millisecond)
	taiSeconds := targetUTC.Unix() + taiUtcOffsetSeconds

	_, status, ok := s.PatchStaged("recv-1", PatchRequest{
		SenderID:     senderIDSet(strPtr("sender-1")),
		MasterEnable: boolPtr(true),
		Activation: &Activation{
			Mode:          strPtr("activate_scheduled_absolute"),
			RequestedTime: strPtr(fmt.Sprintf("%d:%d", taiSeconds, targetUTC.Nanosecond())),
		},
	})
	if !ok || status != http.StatusAccepted {
		t.Fatalf("status = %d, ok = %v, want 202/true", status, ok)
	}

	// Ohne den TAI-Abzug würde der Timer erst nach ~37s feuern — dieser
	// Test wartet bewusst nur eine kurze, realistische Frist (wie das
	// AMWA-Tool selbst, das nach wenigen Sekunden aufgibt).
	time.Sleep(300 * time.Millisecond)

	active, _ := s.Active("recv-1")
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active SenderID after the TAI-based absolute schedule = %v, want sender-1 (timer fired too late — TAI/UTC offset bug)", active.SenderID)
	}
}

func TestPatchStagedUnknownReceiverReturnsFalse(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})
	_, _, ok := s.PatchStaged("does-not-exist", PatchRequest{})
	if ok {
		t.Fatal("PatchStaged(unknown) ok = true, want false")
	}
}

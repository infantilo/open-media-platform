package connection

import "testing"

func strPtr(s string) *string { return &s }

func TestNewReceiverStoreStartsUnconnected(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	active, ok := s.Active("recv-1")
	if !ok {
		t.Fatal("Active(recv-1) ok = false, want true")
	}
	if active.SenderID != nil {
		t.Errorf("SenderID = %v, want nil", active.SenderID)
	}
}

func TestPatchStagedWithImmediateActivationUpdatesActive(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	req := PatchRequest{
		SenderID:     strPtr("sender-1"),
		MasterEnable: true,
		Activation:   Activation{Mode: strPtr("activate_immediate")},
	}
	updated, ok := s.PatchStaged("recv-1", req)
	if !ok {
		t.Fatal("PatchStaged ok = false, want true")
	}
	if updated.SenderID == nil || *updated.SenderID != "sender-1" {
		t.Fatalf("staged SenderID = %v, want sender-1", updated.SenderID)
	}

	active, _ := s.Active("recv-1")
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active SenderID = %v, want sender-1", active.SenderID)
	}
}

func TestPatchStagedWithoutActivationDoesNotUpdateActive(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})

	s.PatchStaged("recv-1", PatchRequest{SenderID: strPtr("sender-1"), MasterEnable: true})

	active, _ := s.Active("recv-1")
	if active.SenderID != nil {
		t.Fatalf("active SenderID = %v, want nil (no activation requested)", active.SenderID)
	}
}

func TestPatchStagedDisconnect(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})
	s.PatchStaged("recv-1", PatchRequest{
		SenderID: strPtr("sender-1"), MasterEnable: true,
		Activation: Activation{Mode: strPtr("activate_immediate")},
	})

	s.PatchStaged("recv-1", PatchRequest{
		SenderID: nil, MasterEnable: false,
		Activation: Activation{Mode: strPtr("activate_immediate")},
	})

	active, _ := s.Active("recv-1")
	if active.SenderID != nil {
		t.Fatalf("active SenderID after disconnect = %v, want nil", active.SenderID)
	}
}

func TestPatchStagedUnknownReceiverReturnsFalse(t *testing.T) {
	s := NewReceiverStore([]string{"recv-1"})
	_, ok := s.PatchStaged("does-not-exist", PatchRequest{})
	if ok {
		t.Fatal("PatchStaged(unknown) ok = true, want false")
	}
}

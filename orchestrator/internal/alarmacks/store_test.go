package alarmacks

import (
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestPutListDeleteRoundtrip(t *testing.T) {
	s := NewStore(dbtest.Open(t))
	_, _ = s.db.Exec(`DELETE FROM alarm_acks`)

	if err := s.Put(Ack{Key: "host:1:offline", Fingerprint: "fp1", Mode: ModeAck, Username: "alice", Comment: "gesehen"}); err != nil {
		t.Fatal(err)
	}
	// Ersetzt denselben Key (neuer Fingerprint, anderer Modus).
	exp := time.Now().Add(time.Hour)
	if err := s.Put(Ack{Key: "host:1:offline", Fingerprint: "fp2", Mode: ModeMask, Username: "bob", ExpiresAt: &exp}); err != nil {
		t.Fatal(err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Fingerprint != "fp2" || got[0].Mode != ModeMask || got[0].Username != "bob" || got[0].ExpiresAt == nil {
		t.Fatalf("List() = %+v", got)
	}
	if err := s.Delete("host:1:offline"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("host:1:offline"); err != nil {
		t.Fatalf("second Delete must not fail: %v", err)
	}
	if got, _ := s.List(); len(got) != 0 {
		t.Fatalf("after Delete: %+v", got)
	}
}

func TestListPrunesExpired(t *testing.T) {
	s := NewStore(dbtest.Open(t))
	_, _ = s.db.Exec(`DELETE FROM alarm_acks`)
	past := time.Now().Add(-time.Minute)
	if err := s.Put(Ack{Key: "a", Fingerprint: "f", Mode: ModeMask, Username: "u", ExpiresAt: &past}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(Ack{Key: "b", Fingerprint: "f", Mode: ModeAck, Username: "u"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Key != "b" {
		t.Fatalf("expired entry not pruned: %+v", got)
	}
}

func TestPutRejectsInvalid(t *testing.T) {
	s := NewStore(dbtest.Open(t))
	for _, a := range []Ack{
		{Fingerprint: "f", Mode: ModeAck},
		{Key: "k", Mode: ModeAck},
		{Key: "k", Fingerprint: "f", Mode: "other"},
	} {
		if err := s.Put(a); err != ErrInvalid {
			t.Errorf("Put(%+v) = %v, want ErrInvalid", a, err)
		}
	}
}

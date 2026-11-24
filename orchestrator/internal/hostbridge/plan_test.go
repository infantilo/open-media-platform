package hostbridge

import (
	"errors"
	"testing"
)

func no() *bool { f := false; return &f }

func all(string) Caps { return Caps{} }

func TestVideoPrefersFabricsThenFallsBack(t *testing.T) {
	e := []Edge{{Medium: Video, SenderHost: "b", ReceiverHost: "a", FromSender: "s1", ToReceiver: "r1", Peer: "Viewer"}}
	br, err := Plan(e, all)
	if err != nil || len(br) != 1 {
		t.Fatalf("plan: %v %v", br, err)
	}
	if got := br[0].Candidates; len(got) != 3 || got[0] != Fabrics || got[1] != ST2110 || got[2] != SRT {
		t.Fatalf("candidates = %v", got)
	}
	// Ein Host ohne Fabrics: Fabrics entfällt, ST 2110 zuerst.
	br, err = Plan(e, func(h string) Caps {
		if h == "a" {
			return Caps{Fabrics: no()}
		}
		return Caps{}
	})
	if err != nil || br[0].Candidates[0] != ST2110 {
		t.Fatalf("fallback: %v %v", br, err)
	}
	// Nur SRT übrig.
	br, err = Plan(e, func(string) Caps { return Caps{Fabrics: no(), ST2110: no()} })
	if err != nil || len(br[0].Candidates) != 1 || br[0].Candidates[0] != SRT {
		t.Fatalf("srt only: %v %v", br, err)
	}
}

func TestAudioOnlyAES67(t *testing.T) {
	e := []Edge{{Medium: Audio, SenderHost: "b", ReceiverHost: "a", FromSender: "s", ToReceiver: "r", Peer: "Mixer"}}
	br, err := Plan(e, all)
	if err != nil || br[0].Candidates[0] != AES67 || len(br[0].Candidates) != 1 {
		t.Fatalf("audio: %v %v", br, err)
	}
	_, err = Plan(e, func(h string) Caps {
		if h == "a" {
			return Caps{AES67: no()}
		}
		return Caps{}
	})
	if !errors.Is(err, ErrNoPath) {
		t.Fatalf("want ErrNoPath, got %v", err)
	}
}

func TestDataHasNoPathAndFailsWholePlan(t *testing.T) {
	e := []Edge{
		{Medium: Video, SenderHost: "b", ReceiverHost: "a", FromSender: "s1", ToReceiver: "r1", Peer: "V"},
		{Medium: Data, SenderHost: "b", ReceiverHost: "a", FromSender: "s2", ToReceiver: "r2", Peer: "ANC"},
	}
	_, err := Plan(e, all)
	if !errors.Is(err, ErrNoPath) {
		t.Fatalf("want ErrNoPath, got %v", err)
	}
}

func TestSameHostIsSkippedAndSharedSenderMerges(t *testing.T) {
	e := []Edge{
		{Medium: Video, SenderHost: "a", ReceiverHost: "a", FromSender: "s", ToReceiver: "local"},
		{Medium: Video, SenderHost: "b", ReceiverHost: "a", FromSender: "s", ToReceiver: "r1", Peer: "V1"},
		{Medium: Video, SenderHost: "b", ReceiverHost: "a", FromSender: "s", ToReceiver: "r2", Peer: "V2"},
		{Medium: Audio, SenderHost: "b", ReceiverHost: "a", FromSender: "s", ToReceiver: "ra", Peer: "V1"},
	}
	br, err := Plan(e, all)
	if err != nil || len(br) != 2 {
		t.Fatalf("plan: %v %v", br, err)
	}
	if len(br[0].Receivers) != 2 || br[0].Receivers[0] != "r1" || br[0].Receivers[1] != "r2" {
		t.Fatalf("merge: %+v", br[0])
	}
}

func TestMediumOfFormat(t *testing.T) {
	if MediumOfFormat("urn:x-nmos:format:video") != Video || MediumOfFormat("urn:x-nmos:format:audio") != Audio ||
		MediumOfFormat("urn:x-nmos:format:data") != Data || MediumOfFormat("x") != "" {
		t.Fatal("MediumOfFormat")
	}
}

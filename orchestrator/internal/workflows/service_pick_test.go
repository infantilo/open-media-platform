package workflows

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func TestPickReceiverPrefersMatchingFormat(t *testing.T) {
	const vid, data, aud = "urn:x-nmos:format:video", "urn:x-nmos:format:data", "urn:x-nmos:format:audio"
	viewer := registry.NodeView{Receivers: []registry.ReceiverView{
		{ID: "tc", Label: "v Zeitcode", Format: data},
		{ID: "sub", Label: "v Untertitel", Format: data},
		{ID: "vid", Label: "v Receiver 1", Format: vid},
	}}
	src := registry.NodeView{Senders: []registry.SenderView{{ID: "s-vid", Label: "s Sender 1", Format: vid}, {ID: "s-aud", Label: "s Sender 2", Format: aud}}}
	if r, _ := pickReceiver(viewer, src, Connection{}); r.ID != "vid" {
		t.Errorf("ohne Angabe: %q, erwartet vid", r.ID)
	}
	if r, _ := pickReceiver(viewer, src, Connection{FromSender: "s Sender 1"}); r.ID != "vid" {
		t.Errorf("mit FromSender: %q, erwartet vid", r.ID)
	}
	if r, _ := pickReceiver(viewer, src, Connection{ToReceiver: "v Untertitel"}); r.ID != "sub" {
		t.Errorf("ausdrücklich: %q, erwartet sub", r.ID)
	}
	// Kein Formattreffer: bisheriges Verhalten (erster Receiver).
	only := registry.NodeView{Senders: []registry.SenderView{{ID: "x", Format: "urn:x-nmos:format:other"}}}
	if r, _ := pickReceiver(viewer, only, Connection{}); r.ID != "tc" {
		t.Errorf("Rückfall: %q, erwartet tc", r.ID)
	}
}

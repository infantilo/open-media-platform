package main

import (
	"context"
	"strings"
	"testing"

	mcrmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/mcr"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeNodes []registry.NodeView

func (f fakeNodes) List() []registry.NodeView { return f }

type fakeGraph struct{ calls []string }

func (g *fakeGraph) Connect(_ context.Context, from, to string) error {
	g.calls = append(g.calls, from+">"+to)
	return nil
}

func linkFixture() (fakeNodes, *fakeGraph) {
	v, a, d := "urn:x-nmos:format:video", "urn:x-nmos:format:audio", "urn:x-nmos:format:data"
	return fakeNodes{
		{ID: "cam", Label: "Kamera", Online: true, Senders: []registry.SenderView{{ID: "cam-v", Format: v}, {ID: "cam-a", Format: a}}},
		{ID: "mic", Label: "Mikro", Online: true, Senders: []registry.SenderView{{ID: "mic-a", Format: a}}},
		{ID: "anc", Label: "ANC", Online: true, Senders: []registry.SenderView{{ID: "anc-d", Format: d}}},
		{ID: "off", Label: "Aus", Online: false, Senders: []registry.SenderView{{ID: "off-v", Format: v}}},
		{ID: "n", InstanceID: "inst", Online: true, Receivers: []registry.ReceiverView{{ID: "r-v", Format: v}, {ID: "r-a", Format: a}, {ID: "r-d", Format: d}}},
	}, &fakeGraph{}
}

func TestLinkMixedNodes(t *testing.T) {
	nodes, g := linkFixture()
	f := mcrFabric{nodes: nodes, graph: g}
	src := mcrmod.Existing{VideoNodeID: "cam", AudioNodeID: "mic", DataNodeID: "anc"}
	if err := f.Link(context.Background(), src, "inst", "inst"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(g.calls, ","); got != "cam-v>r-v,mic-a>r-a,anc-d>r-d" {
		t.Fatalf("Verbindungen: %s", got)
	}
}

func TestLinkSharedSourceStillLinksVideoAndAudioOnly(t *testing.T) {
	nodes, g := linkFixture()
	f := mcrFabric{nodes: nodes, graph: g}
	if err := f.Link(context.Background(), mcrmod.Existing{NodeID: "cam"}, "inst", "inst"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(g.calls, ","); got != "cam-v>r-v,cam-a>r-a" {
		t.Fatalf("Verbindungen: %s", got)
	}
}

func TestLinkOfflinePartIsReported(t *testing.T) {
	nodes, g := linkFixture()
	f := mcrFabric{nodes: nodes, graph: g}
	err := f.Link(context.Background(), mcrmod.Existing{VideoNodeID: "off", VideoNodeLabel: "Aus", AudioNodeID: "mic"}, "inst", "inst")
	if err == nil || !strings.Contains(err.Error(), "Bild") || !strings.Contains(err.Error(), "Aus") {
		t.Fatalf("Fehler erwartet mit Art und Quelle: %v", err)
	}
}

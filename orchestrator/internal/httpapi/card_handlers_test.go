package httpapi

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/ioports"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

func TestDetectedPortsAndMerge(t *testing.T) {
	det := detectedPorts("h1", []launcher.CardConnector{
		{Vendor: "decklink", Device: 0, Dir: "in", Name: "Duo 2"},
		{Vendor: "decklink", Device: 0, Dir: "out", Name: "Duo 2"},
		{Vendor: "decklink", Device: 1, Dir: "sideways", Name: "kaputt"},
	})
	if len(det) != 2 || det[0].PortID != "decklink-0-in" || det[1].PortID != "decklink-0-out" {
		t.Fatalf("detected = %+v", det)
	}
	existing := []ioports.Port{
		{HostID: "h1", PortID: "7", CardType: "decklink", Direction: "in"}, // alter Eintrag wird ersetzt
		{HostID: "h1", PortID: "m0-in", CardType: "matrox", Direction: "in"},
	}
	got := mergeInventory(existing, det)
	if len(got) != 3 {
		t.Fatalf("merge = %+v, want 2 erkannte + matrox", got)
	}
	// Ohne Erkennung bleibt das Inventar unangetastet (z. B. Host ohne Karten).
	if got := mergeInventory(existing, nil); len(got) != 2 {
		t.Fatalf("ohne Erkennung = %+v", got)
	}
}

func TestBuildCardsShowsFreeAndUsedPerDirection(t *testing.T) {
	ports := []ioports.Port{
		{HostID: "h1", PortID: "decklink-0-in", CardType: "decklink", Direction: "in", Label: "Duo 2"},
		{HostID: "h1", PortID: "decklink-0-out", CardType: "decklink", Direction: "out", Label: "Duo 2"},
		{HostID: "h1", PortID: "aja-1-in", CardType: "aja", Direction: "in", Label: "KONA"},
		{HostID: "h1", PortID: "7", CardType: "decklink", Direction: "in"},             // alte Form: nicht im Assistenten
		{HostID: "h2", PortID: "decklink-0-in", CardType: "decklink", Direction: "in"}, // anderer Host
		{HostID: "h1", PortID: "x-in", CardType: "usb-audio", Direction: "in"},         // kein Kartentyp
	}
	claims := []ioports.Claim{{HostID: "h1", PortID: "decklink-0-out", InstanceID: "inst-1", Role: "direct:x"}}
	cards := buildCards("h1", ports, claims)
	if len(cards) != 2 || cards[0].Vendor != "aja" || cards[1].Vendor != "decklink" {
		t.Fatalf("cards = %+v", cards)
	}
	duo := cards[1]
	if len(duo.Ports) != 2 || duo.Ports[0].Dir != "in" || duo.Ports[0].State != "free" ||
		duo.Ports[1].Dir != "out" || duo.Ports[1].State != "used" || duo.Ports[1].InstanceID != "inst-1" {
		t.Fatalf("Duo-Ports = %+v: Eingang soll frei, Ausgang belegt sein", duo.Ports)
	}
}

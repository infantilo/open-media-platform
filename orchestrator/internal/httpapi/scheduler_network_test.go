package httpapi

import (
	"math"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

type fakeCatalog []launcher.CatalogEntry

func (f fakeCatalog) Catalog() []launcher.CatalogEntry { return f }

func TestComputeRoleNetwork(t *testing.T) {
	cat := fakeCatalog{
		{Type: "gw-out", Network: &launcher.CatalogNetwork{Direction: "out", Kind: "video", BitsPerPixel: 20}},
		{Type: "gw-in", Network: &launcher.CatalogNetwork{Direction: "in", Kind: "video", BitsPerPixel: 20}},
		{Type: "audio", Network: &launcher.CatalogNetwork{Direction: "out", Kind: "fixed", Mbps: 10}},
		{Type: "omp-source"},
	}
	def := workflows.Definition{
		Roles: []workflows.Role{
			{Name: "Q", NodeType: "omp-source", Format: "720p50"},
			{Name: "Aus", NodeType: "gw-out"},
			{Name: "Ein", NodeType: "gw-in", Format: "1080p50"},
			{Name: "Ton", NodeType: "audio"},
		},
		Connections: []workflows.Connection{{FromRole: "Q", ToRole: "Aus"}},
	}
	near := func(a, b float64) bool { return math.Abs(a-b) < 1 }

	// 1920×1080×50×20 bit × 1,05 ≈ 2177 Mbit/s, Rx
	in, ok := computeRoleNetwork(cat, def, def.Roles[2])
	if !ok || !near(in.RxMbps, 2177.3) || in.TxMbps != 0 || in.Estimated {
		t.Errorf("1080p50 in = %+v ok=%v", in, ok)
	}
	// Format vom verbundenen Nachbarn (720p50): 1280×720×50×20×1,05 ≈ 967,7 Tx
	out, ok := computeRoleNetwork(cat, def, def.Roles[1])
	if !ok || !near(out.TxMbps, 967.7) || out.Estimated {
		t.Errorf("neighbour format out = %+v", out)
	}
	// Kein Format irgendwo → 1080p50-Fallback, als Schätzung markiert
	def2 := workflows.Definition{Roles: []workflows.Role{{Name: "Aus", NodeType: "gw-out"}}}
	fb, _ := computeRoleNetwork(cat, def2, def2.Roles[0])
	if !near(fb.TxMbps, 2177.3) || !fb.Estimated {
		t.Errorf("fallback = %+v", fb)
	}
	// Workflow-Programmformat vor Fallback
	def2.Settings.ProgramFormat = "720p50"
	pf, _ := computeRoleNetwork(cat, def2, def2.Roles[0])
	if !near(pf.TxMbps, 967.7) || pf.Estimated {
		t.Errorf("programFormat = %+v", pf)
	}
	au, _ := computeRoleNetwork(cat, def, def.Roles[3])
	if au.TxMbps != 10 || !au.Estimated {
		t.Errorf("audio = %+v", au)
	}
	if _, ok := computeRoleNetwork(cat, def, def.Roles[0]); ok {
		t.Error("netzneutraler Typ darf keinen Netzbedarf haben")
	}
	if _, ok := computeRoleNetwork(nil, def, def.Roles[1]); ok {
		t.Error("ohne Katalog kein Netzbedarf")
	}
}

// Die echten Katalog-Einträge: festverdrahtetes Format gilt unverändert
// (auch gegen ein gesetztes Rollen-Format), "both" zählt Rx und Tx.
func TestComputeRoleNetworkRealCatalog(t *testing.T) {
	entries, err := launcher.LoadCatalog("../../../deploy/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	cat := fakeCatalog(entries)
	near := func(a, b float64) bool { return math.Abs(a-b) < 1 }
	def := workflows.Definition{
		Roles: []workflows.Role{
			{Name: "G", NodeType: "omp-2110-gateway-output", Format: "720p50"},
			{Name: "S", NodeType: "omp-srt-gateway-uplink"},
			{Name: "T", NodeType: "omp-fabrics-gateway-target"},
			{Name: "I", NodeType: "omp-fabrics-gateway-initiator"},
			{Name: "Q", NodeType: "omp-source", Format: "2160p50"},
		},
		Connections: []workflows.Connection{{FromRole: "Q", ToRole: "I"}},
	}
	g, ok := computeRoleNetwork(cat, def, def.Roles[0])
	// 1920×1080×25 × 16 bit × 1,05 — das Rollen-Format 720p50 wirkt auf dieses Gateway nicht
	if !ok || !near(g.TxMbps, 870.9) || g.RxMbps != 0 || g.Estimated {
		t.Errorf("2110 out = %+v", g)
	}
	s, _ := computeRoleNetwork(cat, def, def.Roles[1])
	if !near(s.TxMbps, 132.7) || !near(s.RxMbps, 132.7) || !s.Estimated {
		t.Errorf("srt uplink = %+v", s)
	}
	tg, _ := computeRoleNetwork(cat, def, def.Roles[2])
	if !near(tg.RxMbps, 1128.5) || tg.TxMbps != 0 || tg.Estimated {
		t.Errorf("fabrics target = %+v", tg)
	}
	// Initiator folgt dem Format der verbundenen Quelle: 3840×2160×50×21,33×1,02
	a, _ := computeRoleNetwork(cat, def, workflows.Role{Name: "A", NodeType: "omp-aes67-gateway-source"})
	// 2 Kanäle L24/48k: 1000 × (288 + 58) × 8 = 2,768 Mbit/s
	if math.Abs(a.TxMbps-2.768) > 0.01 || a.RxMbps != 0 || a.Estimated {
		t.Errorf("aes67 source = %+v", a)
	}
	// WebRTC: Obergrenzen/Nennwerte, immer als Schätzung markiert
	wc, _ := computeRoleNetwork(cat, def, workflows.Role{Name: "C", NodeType: "omp-webrtc-gateway-camera"})
	wm, _ := computeRoleNetwork(cat, def, workflows.Role{Name: "M", NodeType: "omp-webrtc-gateway-monitor"})
	if wc.RxMbps != 6.4 || wc.TxMbps != 0 || !wc.Estimated || wm.TxMbps != 4.3 || wm.RxMbps != 0 || !wm.Estimated {
		t.Errorf("webrtc camera=%+v monitor=%+v", wc, wm)
	}
	in, _ := computeRoleNetwork(cat, def, def.Roles[3])
	if !near(in.TxMbps, 9022.9) || in.RxMbps != 0 || in.Estimated {
		t.Errorf("fabrics initiator = %+v", in)
	}
}

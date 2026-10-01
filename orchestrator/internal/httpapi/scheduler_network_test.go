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

package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
)

func TestGraphNetwork(t *testing.T) {
	cat := fakeCatalogWithInstances{
		fakeCatalog: fakeCatalog{
			{Type: "gw-in", Network: &launcher.CatalogNetwork{Direction: "in", Kind: "video", Width: 1920, Height: 1080, Fps: 50, BitsPerPixel: 20}},
			{Type: "omp-source"},
		},
		inst: []launcher.Instance{
			{ID: "i1", Type: "gw-in", Label: "Ingest", HostID: "h1"},
			{ID: "i2", Type: "omp-source", Label: "Quelle"},
		},
	}
	reg := fakeHostRegistry{list: []hosts.Host{{ID: "h1", Label: "Regie A"}}}
	metrics := fakeHostMetrics{byHost: map[string]hosts.Metrics{
		"h1": {ReceivedAt: time.Now(), Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 125e6, TxBytesPerSec: 0, LinkMbps: 10000}},
	}}
	rec := httptest.NewRecorder()
	handleGraphNetwork(reg, metrics, cat, placement.DefaultThresholds)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/graph/network", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var resp graphNetResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	gw := resp.Instances["i1"]
	// 1920*1080*50*20 bit * 1,05 = 2177,28 Mbit/s, nur Empfang
	if gw.HostKey != "h1" || gw.TxMbps != 0 || gw.RxMbps < 2177 || gw.RxMbps > 2178 {
		t.Errorf("gw = %+v", gw)
	}
	if n := resp.Instances["i2"]; n.RxMbps != 0 || n.TxMbps != 0 {
		t.Errorf("Node ohne network darf keinen Netzbedarf haben: %+v", n)
	}
	h := resp.Hosts["h1"]
	if !h.Measured || h.LinkMbps != 10000 || h.Percent == nil || *h.Percent < 9.9 || *h.Percent > 10.1 {
		t.Errorf("h1 = %+v", h)
	}
	if resp.Hosts[""].Measured {
		t.Errorf("lokaler Host ohne Messung darf nicht als gemessen gelten: %+v", resp.Hosts[""])
	}
	if resp.ThresholdPercent != placement.DefaultThresholds.NetPercent {
		t.Errorf("threshold = %v", resp.ThresholdPercent)
	}
}

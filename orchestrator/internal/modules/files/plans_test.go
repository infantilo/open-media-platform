package files

import (
	"strings"
	"testing"
	"time"
)

func TestExtractPlansTimingAndRefs(t *testing.T) {
	raw := []byte(`{"items":[
	 {"id":"1","meta":{"label":"Alt","media":{"kind":"file","path":"alt.mxf"},"duration_ms":60000}},
	 {"id":"2","meta":{"label":"Jetzt","media":{"kind":"file","path":"/m/jetzt.mxf"},"duration_ms":120000}},
	 {"id":"3","meta":{"label":"Danach","media":{"kind":"file","path":"danach.mxf"},"duration_ms":30000,"asset":{"assetId":"A1"},"fallbackFile":"ersatz.mxf"}},
	 {"id":"4","meta":{"label":"Fix","media":{"kind":"file","path":"fix.mxf"},"duration_ms":1000,"start_at_utc_ms":5000000}},
	 {"id":"5","meta":{"label":"Live","media":{"kind":"live"},"duration_ms":1000}}],
	 "carts":[{"id":"c","meta":{"label":"Cart","media":{"kind":"file","path":"cart.mxf"},"duration_ms":5000}}],
	 "current_index":1,"on_air":true,"onair_utc_ms":1000000}`)
	ps := extractPlans("K1", raw, 999)
	by := map[string]planItem{}
	for _, p := range ps {
		k := p.Path
		if p.AssetID != "" {
			k = "asset:" + p.AssetID
		}
		by[k] = p
	}
	if len(by) != 7 { // alt, jetzt, danach, asset:A1, ersatz, fix, cart
		t.Fatalf("Bezüge: %d %v", len(by), by)
	}
	if a := by["alt.mxf"]; !a.Aired || a.EndMs != 1000000 || a.StartMs != 940000 {
		t.Fatalf("alt: %+v", a)
	}
	if a := by["/m/jetzt.mxf"]; !a.OnAir || a.StartMs != 1000000 || a.EndMs != 1120000 {
		t.Fatalf("jetzt: %+v", a)
	}
	if a := by["danach.mxf"]; a.Aired || a.OnAir || a.StartMs != 1120000 {
		t.Fatalf("danach: %+v", a)
	}
	if a := by["fix.mxf"]; a.StartMs != 5000000 {
		t.Fatalf("fixtime: %+v", a)
	}
	if a := by["ersatz.mxf"]; !a.Fallback || a.Aired {
		t.Fatalf("ersatz: %+v", a)
	}
	if a := by["cart.mxf"]; !a.Cart || a.StartMs != 0 {
		t.Fatalf("cart: %+v", a)
	}
}

func TestPathMatches(t *testing.T) {
	cases := []struct {
		plan, abs string
		want      bool
	}{{"/m/a.mxf", "/m/a.mxf", true}, {"a.mxf", "/m/a.mxf", true}, {"sub/a.mxf", "/m/sub/a.mxf", true}, {"a.mxf", "/m/xa.mxf", false}, {"/n/a.mxf", "/m/a.mxf", false}, {"", "/m/a.mxf", false}}
	for _, c := range cases {
		if got := pathMatches(c.plan, c.abs); got != c.want {
			t.Errorf("%q vs %q = %v", c.plan, c.abs, got)
		}
	}
}

func TestLockLevel(t *testing.T) {
	now := time.UnixMilli(10_000_000_000)
	h := time.Hour
	ms := func(d time.Duration) int64 { return now.Add(d).UnixMilli() }
	cases := []struct {
		name    string
		p       planItem
		planned bool
		want    int
		text    string
	}{
		{"on air", planItem{OnAir: true}, true, levelAbsolute, "läuft"},
		{"gerade gesendet im Nachlauf", planItem{Aired: true, EndMs: ms(-2 * h)}, true, levelHard, "gesperrt bis"},
		{"Nachlauf vorbei", planItem{Aired: true, EndMs: ms(-7 * h)}, true, levelNone, ""},
		{"gesendet, Ende unbekannt", planItem{Aired: true}, true, levelNone, ""},
		{"im Vorlauf", planItem{StartMs: ms(3 * h)}, false, levelHard, "Sperrfenster"},
		{"weit voraus, bis nicht mehr verplant", planItem{StartMs: ms(100 * h)}, true, levelHard, "verplant"},
		{"weit voraus, nur Fenster", planItem{StartMs: ms(100 * h)}, false, levelSoft, "verplant"},
		{"ohne Zeit", planItem{}, true, levelHard, "Playlist"},
		{"ohne Zeit weich", planItem{Cart: true}, false, levelSoft, "Playlist"},
	}
	for _, c := range cases {
		lv, txt := lockLevel(c.p, now, 24*h, 6*h, c.planned)
		if lv != c.want || (c.text != "" && !strings.Contains(txt, c.text)) {
			t.Errorf("%s: level %d %q", c.name, lv, txt)
		}
	}
}

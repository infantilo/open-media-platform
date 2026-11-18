package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMXLFlowsAction(t *testing.T) {
	base := filepath.Join(t.TempDir(), "omp-mxl")
	t.Setenv("OMP_MXL_DOMAIN", base)
	e := NewExecutor(nil, "", "", "", "host-1", nil)

	// ungültiger Domainname: abgelehnt, kein Pfad wird gebildet
	if r := e.Handle(Request{Action: "mxl-flows", Domain: "../etc"}); r.OK {
		t.Fatalf("ungültiger Name muss abgelehnt werden: %+v", r)
	}
	// Standard- und benannte Domain ohne Verzeichnis: leere Liste, kein Fehler
	for _, dom := range []string{"", "default", "studio"} {
		r := e.Handle(Request{Action: "mxl-flows", Domain: dom})
		if !r.OK {
			t.Fatalf("%q: %+v", dom, r)
		}
		var out struct {
			Domain string            `json:"domain"`
			Flows  []json.RawMessage `json:"flows"`
		}
		if err := json.Unmarshal([]byte(r.Detail), &out); err != nil || len(out.Flows) != 0 {
			t.Fatalf("%q: %v %q", dom, err, r.Detail)
		}
		want := base
		if dom == "studio" {
			want = base + "-studio"
		}
		if out.Domain != want {
			t.Errorf("%q: Domain %q, want %q", dom, out.Domain, want)
		}
	}
	// ein Flow-Verzeichnis ohne Schreiber ist ein Rest
	flow := filepath.Join(base+"-studio", "11111111-1111-1111-1111-111111111111.mxl-flow")
	if err := os.MkdirAll(flow, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(flow, "data"), make([]byte, 16), 0o644)
	r := e.Handle(Request{Action: "mxl-flows", Domain: "studio"})
	if !r.OK || !json.Valid([]byte(r.Detail)) {
		t.Fatalf("%+v", r)
	}
	var out struct {
		Flows []struct {
			ID    string `json:"id"`
			Stale bool   `json:"stale"`
		} `json:"flows"`
	}
	_ = json.Unmarshal([]byte(r.Detail), &out)
	if len(out.Flows) != 1 || !out.Flows[0].Stale {
		t.Fatalf("Rest erwartet: %s", r.Detail)
	}
}

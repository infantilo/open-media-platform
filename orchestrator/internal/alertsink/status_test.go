package alertsink

import (
	"bytes"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
)

func sampleReport() *StatusReport {
	label := map[string]string{"cam": "Kamera 1", "sw": "Mischer", "enc": "Encoder", "mon": "Monitor"}
	ok := map[string]bool{"cam": true, "sw": true, "enc": false, "mon": true}
	edges := []FlowEdge{{"cam", "sw"}, {"mon", "sw"}, {"sw", "enc"}}
	return &StatusReport{Time: time.Unix(1700000000, 0).UTC(),
		Orchestrator: OrchestratorInfo{Name: "orch-a", Version: "0.10.0", Leader: true, Peers: 2},
		Hosts:        []HostInfo{{Name: "host-1", Online: true, CPU: 40, Mem: 55}, {Name: "host-2", Online: false, Note: "betroffen"}},
		Workflows:    []WorkflowInfo{{Name: "Hauptsendung", Status: "started", Nodes: 4, Down: 1}},
		Flow:         UpstreamOf("enc", edges, label, ok)}
}

func TestUpstreamOfBisWurzel(t *testing.T) {
	g := sampleReport().Flow
	if len(g.Nodes) != 4 || len(g.Edges) != 3 {
		t.Fatalf("Nodes=%d Edges=%d", len(g.Nodes), len(g.Edges))
	}
	// Schleife darf nicht hängen
	label := map[string]string{"a": "A", "b": "B"}
	l := UpstreamOf("a", []FlowEdge{{"a", "b"}, {"b", "a"}}, label, map[string]bool{})
	if len(l.Nodes) != 2 {
		t.Fatalf("Schleife: %d", len(l.Nodes))
	}
	if _, err := l.PNG("x"); err != nil {
		t.Fatal(err)
	}
	if n := UpstreamOf("fehlt", nil, label, nil); len(n.Nodes) != 0 {
		t.Fatal("unbekannter Fokus")
	}
}

func TestStatusTextUndPNG(t *testing.T) {
	r := sampleReport()
	txt := r.Text()
	for _, w := range []string{"orch-a", "Leader", "OFFLINE", "host-2", "Hauptsendung", "Encoder [AUSFALL]", "<- Mischer", "<- Kamera 1"} {
		if !strings.Contains(txt, w) {
			t.Errorf("Text ohne %q:\n%s", w, txt)
		}
	}
	b, err := r.Flow.PNG("Signalweg bis zur Wurzel: Äpfel/Öl ß")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := png.Decode(bytes.NewReader(b)); err != nil {
		t.Fatal(err)
	}
	if p := os.Getenv("OMP_TEST_PNG_OUT"); p != "" {
		_ = os.WriteFile(p, b, 0o644)
	}
}

func TestMessageMitStatus(t *testing.T) {
	m := &Mailer{From: "omp@example.org", Routes: []Route{{Name: "r", Enabled: true, To: "a@example.org", Status: StatusGraph}}}
	a := Alert{Kind: "node-alert", Severity: "critical", Subject: "enc", Name: "Encoder", Message: "tot", Time: time.Now()}
	if m.StatusMode(a) != StatusGraph {
		t.Fatal("Modus")
	}
	a.StatusMode, a.Status = StatusGraph, sampleReport()
	msg := string(m.Message(a, []string{"a@example.org"}))
	for _, w := range []string{"multipart/alternative", "multipart/related", "Content-ID: <signalweg@omp>", "cid:signalweg@omp", "Signalweg bis zur Wurzel"} {
		if !strings.Contains(msg, w) {
			t.Errorf("Mail ohne %q", w)
		}
	}
	a.StatusMode = StatusText
	msg = string(m.Message(a, nil))
	if strings.Contains(msg, "multipart") || !strings.Contains(msg, "Orchestrator: orch-a") {
		t.Errorf("Textmodus:\n%s", msg)
	}
	a.Status = nil
	if strings.Contains(string(m.Message(a, nil)), "Orchestrator:") {
		t.Error("ohne Report kein Block")
	}
	if (Route{Status: "bunt"}).Validate() == nil {
		t.Error("ungültiger Modus muss abgelehnt werden")
	}
}

func TestSVGUndEntwederOder(t *testing.T) {
	svg := string(sampleReport().Flow.SVG("Titel <x>"))
	for _, w := range []string{"<svg", "Encoder", "Titel &lt;x&gt;", "</svg>"} {
		if !strings.Contains(svg, w) {
			t.Errorf("SVG ohne %q", w)
		}
	}
	m := &Mailer{From: "omp@example.org", Routes: []Route{
		{Name: "a", Enabled: true, To: "a@example.org", Status: StatusSVG},
		{Name: "b", Enabled: true, To: "b@example.org", Status: StatusGraph}}}
	a := Alert{Kind: "node-alert", Severity: "critical", Subject: "enc", Name: "Encoder", Message: "tot", Time: time.Now()}
	if m.StatusMode(a) != StatusSVG {
		t.Fatalf("erste Grafik-Regel gewinnt, war %q", m.StatusMode(a))
	}
	a.StatusMode, a.Status = StatusSVG, sampleReport()
	msg := string(m.Message(a, nil))
	if !strings.Contains(msg, "multipart/mixed") || !strings.Contains(msg, "image/svg+xml") || strings.Contains(msg, "image/png") {
		t.Error("SVG-Mail falsch aufgebaut")
	}
}

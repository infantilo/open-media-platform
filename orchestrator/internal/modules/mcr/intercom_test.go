package mcr

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

type fakeIC struct {
	mu    sync.Mutex
	calls []string
	fail  bool
}

func (f *fakeIC) CallRole(_ context.Context, kind, role string, params []string, body any, _ string) (int, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf("%s:%s:%v", kind, role, params))
	if f.fail {
		return 0, nil, fmt.Errorf("Intercom aus")
	}
	if role == "event.return.create" {
		return 201, []byte(`{"return":{"key":"k","ret_channel":7,"ret_in":3,"ret_out":2},"guest":null}`), nil
	}
	return 200, []byte(`{"ok":true,"removed":1}`), nil
}

type fakeFabric struct {
	connects []string
	noSender bool
}

func (f *fakeFabric) AudioSender(inst, hint string) (string, bool) {
	if f.noSender {
		return "", false
	}
	return "snd(" + inst + "," + hint + ")", true
}
func (f *fakeFabric) AudioReceiver(inst string) (string, bool) { return "rcv(" + inst + ")", true }
func (f *fakeFabric) IntercomReceiver(slot int) (string, bool) { return fmt.Sprintf("icin%d", slot), true }
func (f *fakeFabric) IntercomSender(slot int) (string, bool)   { return fmt.Sprintf("icout%d", slot), true }
func (f *fakeFabric) Connect(_ context.Context, a, b string) error {
	f.connects = append(f.connects, a+"->"+b)
	return nil
}

type postNodes struct {
	fakeNodes
	posts []string
}

func (n *postNodes) Do(ctx context.Context, method, url string, body any) ([]byte, int, error) {
	if method == "POST" {
		n.mu.Lock()
		b, _ := json.Marshal(body)
		n.posts = append(n.posts, url+" "+string(b))
		n.mu.Unlock()
		return []byte(`{"ok":true}`), 200, nil
	}
	return n.fakeNodes.Do(ctx, method, url, body)
}

func lineWith(id, name, ic string) Line {
	return Line{ID: id, Name: name, Kind: KindMXL, Intercom: json.RawMessage(ic)}
}

func TestPlanReturnRules(t *testing.T) {
	pgm := Line{ID: "pgm", Name: "PGM", Kind: KindSRT}
	// Quelle ohne Kommentar (Leitung) → direkt
	p := PlanReturn(lineWith("kom", "Kommentator", `{"return":{"mode":"mix","source":{"type":"line","lineId":"pgm"}}}`), []Line{pgm})
	if p.Action != "direct" || p.SourceLine != "pgm" || p.Mode != "mix" {
		t.Fatalf("direkt: %+v", p)
	}
	// Quelle mit Kommentar (Mischer) → N-1
	p = PlanReturn(lineWith("kom", "Kommentator", `{"return":{"source":{"type":"mixer","role":"mischer","auxId":"2","commentChannel":"5"}}}`), nil)
	if p.Action != "n1" || p.AuxID != "2" || p.CommentChannel != "5" || p.MixerRole != "mischer" {
		t.Fatalf("n1: %+v", p)
	}
	// Mischer ohne Kommentarkanal → Warnung (Kommentator würde sich hören), nie stiller Ersatz
	p = PlanReturn(lineWith("kom", "Kommentator", `{"return":{"source":{"type":"mixer","role":"mischer","auxId":"2"}}}`), nil)
	if p.Action != "warn" || !strings.Contains(p.Warn, "selbst hören") {
		t.Fatalf("Warnung: %+v", p)
	}
	// keine Quelle / unbekannte Quellleitung / Quelle = sich selbst → Warnung
	for _, ic := range []string{`{"return":{"mode":"mix"}}`, `{"return":{"source":{"type":"line","lineId":"gibtsnicht"}}}`, `{"return":{"source":{"type":"line","lineId":"kom"}}}`} {
		if p := PlanReturn(lineWith("kom", "K", ic), []Line{pgm, lineWith("kom", "K", ic)}); p.Action != "warn" {
			t.Fatalf("%s → %+v", ic, p)
		}
	}
	// ohne Rückweg: nichts
	if PlanReturn(Line{ID: "x", Name: "X", Kind: KindMXL}, nil).Wanted {
		t.Fatal("ohne return nichts")
	}
}

func icEnv(t *testing.T, ic *Intercom, lines []Line) (*Runtime, Event, map[string]LineRoles, func(string) string, *postNodes) {
	nodes := &postNodes{}
	rt := &Runtime{Wf: newFakeWf(), Nodes: nodes, Intercom: ic}
	e := Event{ID: "ev1", Name: "Spiel", Lines: lines}
	roles := map[string]LineRoles{}
	for _, l := range lines {
		roles[l.ID] = LineRoles{Normalizer: l.ID + "-norm", Return: l.ID + "-ret"}
	}
	inst := func(role string) string { return "inst-" + role }
	return rt, e, roles, inst, nodes
}

func TestEnsureDirectConnectsSourceAndReturn(t *testing.T) {
	fab := &fakeFabric{}
	ic := &Intercom{Svc: &fakeIC{}, Fabric: fab}
	lines := []Line{{ID: "pgm", Name: "PGM", Kind: KindSRT},
		lineWith("kom", "Kommentator", `{"return":{"mode":"mix","source":{"type":"line","lineId":"pgm"},"transport":{"uri":"srt://10.0.0.9:9100"}}}`)}
	rt, e, roles, inst, _ := icEnv(t, ic, lines)
	warns := ic.Ensure(context.Background(), rt, nil, e, inst, roles)
	if len(warns) != 0 {
		t.Fatalf("Warnungen: %v", warns)
	}
	want := []string{"snd(inst-pgm-norm,)->icin3", "icout2->rcv(inst-kom-ret)"}
	if strings.Join(fab.connects, "|") != strings.Join(want, "|") {
		t.Fatalf("Verbindungen: %v", fab.connects)
	}
}

func TestEnsureN1CallsSetN1ExactlyOnceWithExclude(t *testing.T) {
	fab := &fakeFabric{}
	ic := &Intercom{Svc: &fakeIC{}, Fabric: fab}
	lines := []Line{lineWith("kom", "Kommentator", `{"return":{"mode":"guest","source":{"type":"mixer","role":"mischer","auxId":"2","commentChannel":"5","sender":"Aux 2"}}}`)}
	rt, e, roles, inst, nodes := icEnv(t, ic, lines)
	warns := ic.Ensure(context.Background(), rt, nil, e, inst, roles)
	if len(warns) != 0 {
		t.Fatalf("Warnungen: %v", warns)
	}
	n := 0
	for _, p := range nodes.posts {
		if strings.Contains(p, "/methods/aux.2.setN1") {
			n++
			if !strings.Contains(p, `"exclude":"5"`) || !strings.Contains(p, "inst-mischer") {
				t.Fatalf("setN1 falsch: %s", p)
			}
		}
	}
	if n != 1 {
		t.Fatalf("setN1 muss genau einmal aufgerufen werden, war %d: %v", n, nodes.posts)
	}
	if len(fab.connects) != 1 || !strings.HasPrefix(fab.connects[0], "snd(inst-mischer,Aux 2)->icin3") {
		t.Fatalf("Verbindung: %v", fab.connects)
	}
}

func TestEnsureWithoutSourceWarnsAndDoesNotConnect(t *testing.T) {
	fab := &fakeFabric{}
	ic := &Intercom{Svc: &fakeIC{}, Fabric: fab}
	lines := []Line{lineWith("kom", "Kommentator", `{"return":{"mode":"mix"}}`)}
	rt, e, roles, inst, nodes := icEnv(t, ic, lines)
	warns := ic.Ensure(context.Background(), rt, nil, e, inst, roles)
	if len(warns) != 1 || !strings.Contains(warns[0], "keine Quelle") {
		t.Fatalf("Warnung erwartet: %v", warns)
	}
	if len(fab.connects) != 0 || len(nodes.posts) != 0 {
		t.Fatal("ohne Quelle darf nichts verbunden oder angelegt werden")
	}
	// Quelllinie läuft nicht / Intercom aus → Warnung statt Absturz
	lines = []Line{{ID: "pgm", Name: "PGM", Kind: KindSRT}, lineWith("kom", "K", `{"return":{"source":{"type":"line","lineId":"pgm"}}}`)}
	rt, e, roles, _, _ = icEnv(t, ic, lines)
	if w := ic.Ensure(context.Background(), rt, nil, e, func(string) string { return "" }, roles); len(w) != 1 || !strings.Contains(w[0], "läuft noch nicht") {
		t.Fatalf("Quelle läuft nicht: %v", w)
	}
	ic2 := &Intercom{Svc: &fakeIC{fail: true}, Fabric: fab}
	if w := ic2.Ensure(context.Background(), rt, nil, e, func(r string) string { return "i-" + r }, roles); len(w) != 1 || !strings.Contains(w[0], "Intercom nicht erreichbar") {
		t.Fatalf("Intercom aus: %v", w)
	}
}

func TestTeardownOnlyWhenReturnsWanted(t *testing.T) {
	svc := &fakeIC{}
	ic := &Intercom{Svc: svc, Fabric: &fakeFabric{}}
	if err := ic.Teardown(context.Background(), Event{ID: "e", Lines: []Line{{ID: "a", Name: "A", Kind: KindMXL}}}); err != nil || len(svc.calls) != 0 {
		t.Fatalf("ohne Rückweg kein Aufruf: %v %v", err, svc.calls)
	}
	e := Event{ID: "e", Lines: []Line{lineWith("k", "K", `{"return":{"mode":"mix"}}`)}}
	if err := ic.Teardown(context.Background(), e); err != nil || len(svc.calls) != 1 || !strings.Contains(svc.calls[0], "event.return.delete:[e]") {
		t.Fatalf("Abbau: %v %v", err, svc.calls)
	}
	var nilIC *Intercom
	if err := nilIC.Teardown(context.Background(), e); err != nil {
		t.Fatal("nil-Intercom darf nicht stören")
	}
}

func TestMaterializeAddsReturnRole(t *testing.T) {
	e := Event{ID: "abcdef1234567890", Name: "X", State: StateTesting, Lines: []Line{
		{ID: "l1", Name: "Kommentator", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9000"}`),
			Intercom: json.RawMessage(`{"return":{"mode":"mix","source":{"type":"line","lineId":"l2"},"transport":{"uri":"srt://10.1.1.1:9100","mode":"caller","audioBitrateKbps":96}}}`)},
		{ID: "l2", Name: "PGM", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9001"}`)},
	}}
	def, roles, envs, err := Materialize(e, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if roles["l1"].Return != "kommentator-ret" || roles["l2"].Return != "" {
		t.Fatalf("Rückleitungs-Rolle: %+v", roles)
	}
	found := false
	for _, r := range def.Roles {
		if r.Name == "kommentator-ret" && r.NodeType == NodeContribOut {
			found = true
		}
	}
	if !found || envs["kommentator-ret"]["OMP_CONTRIB_URI"] != "srt://10.1.1.1:9100" || envs["kommentator-ret"]["OMP_CONTRIB_AUDIO_BITRATE_KBPS"] != "96" {
		t.Fatalf("Rückleitung: %v %v", def.Roles, envs["kommentator-ret"])
	}
}

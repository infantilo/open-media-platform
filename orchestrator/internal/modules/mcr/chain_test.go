package mcr

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func TestResolveChainPrecedence(t *testing.T) {
	g := raw(`[{"id":"g1","nodeType":"omp-scaler","where":"pre"}]`)
	e := raw(`[{"id":"e1","nodeType":"omp-scaler","where":"post"}]`)
	l := raw(`[{"id":"l1","nodeType":"omp-scaler","where":"pre"}]`)
	ids := func(c []Stage) string {
		var o []string
		for _, s := range c {
			o = append(o, s.ID)
		}
		return strings.Join(o, ",")
	}
	if ids(ResolveChain(g, nil, nil)) != "g1" || ids(ResolveChain(g, e, nil)) != "e1" || ids(ResolveChain(g, e, l)) != "l1" {
		t.Fatal("die nächstbesondere Liste gilt ganz")
	}
	if got := ResolveChain(g, e, raw(`[]`)); got == nil || len(got) != 0 {
		t.Fatalf("[] heißt ausdrücklich keine Stufen: %v", got)
	}
	if ids(ResolveChain(g, raw(`null`), raw(`null`))) != "g1" {
		t.Fatal("null erbt")
	}
	off := raw(`[{"id":"a","nodeType":"omp-scaler","where":"pre","enabled":false},{"id":"b","nodeType":"omp-scaler","where":"pre"}]`)
	if ids(ResolveChain(nil, nil, off)) != "b" {
		t.Fatal("ausgeschaltete Stufen entfallen")
	}
}

func TestValidateChain(t *testing.T) {
	cc := ChainConfig{Types: []StageType{{NodeType: "omp-scaler", Video: true}, {NodeType: "omp-filter-x", Video: true, Audio: true}}}
	ok := raw(`[{"id":"s1","nodeType":"omp-scaler","where":"pre","params":{"x":1}}]`)
	if err := ValidateChain("T", ok, cc); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]string{
		"unbekannter Typ": `[{"id":"s1","nodeType":"omp-evil","where":"pre"}]`,
		"falscher Platz":  `[{"id":"s1","nodeType":"omp-scaler","where":"mitte"}]`,
		"doppelte ID":     `[{"id":"s1","nodeType":"omp-scaler","where":"pre"},{"id":"s1","nodeType":"omp-scaler","where":"post"}]`,
		"schlechte ID":    `[{"id":"S 1","nodeType":"omp-scaler","where":"pre"}]`,
		"Geheimnis":       `[{"id":"s1","nodeType":"omp-scaler","where":"pre","params":{"passphrase":"x"}}]`,
		"keine Liste":     `{"a":1}`,
	} {
		if err := ValidateChain("T", raw(c), cc); err == nil {
			t.Errorf("%s: muss abgelehnt werden", name)
		}
	}
	many := "["
	for i := 0; i < MaxStages+1; i++ {
		if i > 0 {
			many += ","
		}
		many += `{"id":"s` + string(rune('a'+i)) + `","nodeType":"omp-scaler","where":"pre"}`
	}
	if err := ValidateChain("T", raw(many+"]"), cc); err == nil {
		t.Error("zu viele Stufen")
	}
	if err := ValidateChain("T", nil, cc); err != nil {
		t.Error("fehlend = erbt, kein Fehler")
	}
}

func TestMaterializeWithChain(t *testing.T) {
	cc := ChainConfig{Types: []StageType{{NodeType: "omp-scaler", Video: true}, {NodeType: "omp-filter-x", Video: true, Audio: true}}}
	chain := raw(`[{"id":"sc","nodeType":"omp-scaler","where":"pre"},{"id":"f1","nodeType":"omp-filter-x","where":"post"}]`)
	e := Event{ID: "ev", Name: "K", Chain: chain, Lines: []Line{{ID: "l1", Name: "A", Kind: KindSRT, Transport: raw(`{"uri":"srt://:9000"}`)}}}
	def, roles, _, err := Materialize(e, nil, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	lr := roles["l1"]
	if lr.Input != "a-in" || lr.Normalizer != "a-norm" || len(lr.Pre) != 1 || len(lr.Post) != 1 {
		t.Fatalf("Rollen: %+v", lr)
	}
	if lr.OutVideo != "a-post-f1" || lr.OutAudio != "a-post-f1" {
		t.Fatalf("Ausgang = letzte Stufe: %+v", lr)
	}
	got := map[string]bool{}
	for _, c := range def.Connections {
		got[c.FromRole+":"+c.FromSender+">"+c.ToRole+":"+c.ToReceiver] = true
	}
	want := []string{
		"a-in:Sender 1>a-pre-sc:Receiver 1",    // Bild: Eingang → Skalierer
		"a-pre-sc:Sender 1>a-norm:Receiver 1",  // Bild: Skalierer → Normalizer
		"a-in:Sender 2>a-norm:Receiver 2",      // Ton geht am Bild-Skalierer vorbei
		"a-norm:Sender 1>a-post-f1:Receiver 1", // Bild → Filter
		"a-norm:Sender 2>a-post-f1:Receiver 2", // Ton → Filter
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("Verbindung fehlt: %s (vorhanden: %v)", w, got)
		}
	}
	if len(def.Connections) != len(want) {
		t.Errorf("%d Verbindungen, erwartet %d", len(def.Connections), len(want))
	}
	if o := def.Interface.Outputs[0].Members; o[0].Role != "a-post-f1" || o[1].Role != "a-post-f1" {
		t.Fatalf("Schnittstelle am Kettenende: %+v", o)
	}
	if n := SourceNames(e, cc); n["a-post-f1"] != "MCR/K/A" || n["a-norm"] != "MCR/K/A" {
		t.Fatalf("Quellname am Kettenende: %v", n)
	}
	// Leitung überschreibt: keine Stufen
	e.Lines[0].Chain = raw(`[]`)
	_, roles, _, _ = Materialize(e, nil, "", cc)
	if roles["l1"].OutVideo != "a-norm" || len(roles["l1"].Pre) != 0 {
		t.Fatalf("Leitung ohne Stufen: %+v", roles["l1"])
	}
}

func TestExistingSourceGoesToFirstStageThatTakesTheKind(t *testing.T) {
	cc := ChainConfig{Types: []StageType{{NodeType: "omp-scaler", Video: true}}}
	e := Event{ID: "ev", Name: "K", Chain: raw(`[{"id":"sc","nodeType":"omp-scaler","where":"pre"}]`), Lines: []Line{{ID: "l1", Name: "A", Kind: KindMXL, Transport: raw(`{"existing":{"nodeId":"n"}}`)}}}
	def, roles, _, err := Materialize(e, nil, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	lr := roles["l1"]
	if lr.Input != "" || lr.VideoIn() != "a-pre-sc" || lr.AudioIn() != "a-norm" {
		t.Fatalf("Bild zuerst an den Skalierer, Ton direkt an den Normalizer: %+v", lr)
	}
	if len(def.Connections) != 1 || def.Connections[0].FromRole != "a-pre-sc" {
		t.Fatalf("nur Skalierer → Normalizer (Bild): %+v", def.Connections)
	}
}

func TestMaterializeRejectsTypeNotAllowed(t *testing.T) {
	e := Event{ID: "ev", Name: "K", Lines: []Line{{ID: "l1", Name: "A", Kind: KindMXL, Transport: raw(`{"sourceNodeType":"omp-source"}`), Chain: raw(`[{"id":"x","nodeType":"omp-evil","where":"pre"}]`)}}}
	if _, _, _, err := Materialize(e, nil, ""); err == nil {
		t.Fatal("nicht zugelassener Typ darf nicht in den Workflow")
	}
}

func TestChainPersistsAndSettingsRoundTrip(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	ctx := context.Background()
	if got := svc.StageTypes(); len(got) != 1 || got[0].NodeType != "omp-scaler" {
		t.Fatalf("Standardtypen: %+v", got)
	}
	types := []StageType{{NodeType: "omp-scaler", Video: true}, {NodeType: "omp-filter-x", Video: true, Audio: true}}
	if err := svc.SetChainSettings(raw(`[{"id":"g","nodeType":"omp-filter-x","where":"post"}]`), &types); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetChainSettings(raw(`[{"id":"g","nodeType":"omp-evil","where":"post"}]`), nil); err == nil {
		t.Fatal("globale Kette mit unzulässigem Typ muss abgelehnt werden")
	}
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "C", Chain: raw(`[{"id":"e","nodeType":"omp-scaler","where":"pre"}]`), Lines: []Line{
		{Name: "A", Kind: KindMXL, Transport: raw(`{"sourceNodeType":"omp-source"}`), Chain: raw(`[]`)},
		{Name: "B", Kind: KindMXL, Transport: raw(`{"sourceNodeType":"omp-source"}`)},
	}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := svc.St.GetEvent(ctx, ev.ID)
	if !strings.Contains(string(got.Chain), `"scaler"`) && !strings.Contains(string(got.Chain), "omp-scaler") {
		t.Fatalf("Ereigniskette nicht gespeichert: %s", got.Chain)
	}
	if string(got.Lines[0].Chain) != "[]" || len(got.Lines[1].Chain) != 0 {
		t.Fatalf("Leitungsketten: %q %q", got.Lines[0].Chain, got.Lines[1].Chain)
	}
	if _, err := svc.CreateEvent(ctx, NewEventInput{Name: "X", Chain: raw(`[{"id":"e","nodeType":"omp-evil","where":"pre"}]`), Lines: []Line{{Name: "A", Kind: KindMXL, Transport: raw(`{"sourceNodeType":"omp-source"}`)}}}, "alice"); err == nil {
		t.Fatal("Event mit unzulässiger Stufe muss abgelehnt werden")
	}
}

func TestLiveEventRejectsChainChange(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	ctx := context.Background()
	rt := &Runtime{Wf: newFakeWf(), Nodes: &fakeNodes{}, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	_ = svc.SetGlobalHouse(raw(house1080))
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "L", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: raw(`{"sourceNodeType":"omp-source"}`)}}}, "a")
	if err != nil {
		t.Fatal(err)
	}
	for _, to := range []string{StateTesting, StateLive} {
		if ev, err = svc.Transition(ctx, ev.ID, to, "a", true); err != nil {
			t.Fatal(err)
		}
	}
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	in := NewEventInput{Name: cur.Name, Lines: cur.Lines, Chain: raw(`[{"id":"s","nodeType":"omp-scaler","where":"pre"}]`)}
	if _, err := svc.UpdateEvent(ctx, ev.ID, in, true, "a"); err == nil {
		t.Fatal("Kettenänderung auf Sendung muss abgelehnt werden")
	}
	in.Chain = nil
	if _, err := svc.UpdateEvent(ctx, ev.ID, in, true, "a"); err != nil {
		t.Fatalf("unveränderte Kette bleibt erlaubt: %v", err)
	}
}

func TestMaterializeWithFunctionSlots(t *testing.T) {
	cc := ChainConfig{Slots: Slots{
		Normalizer: Slot{NodeType: "omp-normalizer-v2"},
		Converter:  Slot{NodeType: "omp-udc-pro", Video: true},
		AVDelay:    Slot{NodeType: "omp-avdelay-pro", Video: true, Audio: true},
	}}
	e := Event{ID: "ev", Name: "K", Lines: []Line{{ID: "l1", Name: "A", Kind: KindSRT, Transport: raw(`{"uri":"srt://:9000"}`)}}}
	def, roles, _, err := Materialize(e, nil, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	for _, r := range def.Roles {
		types[r.Name] = r.NodeType
	}
	if types["a-norm"] != "omp-normalizer-v2" || types["a-pre-conv"] != "omp-udc-pro" || types["a-post-avdelay"] != "omp-avdelay-pro" {
		t.Fatalf("Rollen/Typen: %v", types)
	}
	if lr := roles["l1"]; lr.OutVideo != "a-post-avdelay" {
		t.Fatalf("Kette: %+v", lr)
	}
	// Standard: alles im Normalizer, keine Zusatzstufen.
	def, _, _, _ = Materialize(e, nil, "", ChainConfig{})
	if len(def.Roles) != 2 {
		t.Fatalf("Standard: %d Rollen, erwartet 2 (Eingang + Normalizer)", len(def.Roles))
	}
	if err := (Slots{Converter: Slot{NodeType: "x y"}}).Validate(); err == nil {
		t.Error("ungültiger Typname muss abgelehnt werden")
	}
	if err := (Slots{AVDelay: Slot{NodeType: "omp-x"}}).Validate(); err == nil {
		t.Error("Slot ohne Bild/Ton muss abgelehnt werden")
	}
}

func TestNormalizerOverridesFromSlots(t *testing.T) {
	l := Line{ID: "l1", Name: "A", Kind: KindSRT, Avsync: raw(`{"mode":"once","heldMs":40}`)}
	last := func(ps []ParamSet, name string) any {
		var v any
		for _, p := range ps {
			if p.Name == name {
				v = p.Value
			}
		}
		return v
	}
	// Standard: Einstellung der Leitung gilt, kein Zwang.
	if v := last(NodeParams(l, HouseFormat{}, DefaultSlots()), "avsync.mode"); v != "once" {
		t.Fatalf("Standard: %v", v)
	}
	// Getrennter A/V-Delay: Normalizer-Ausgleich aus, auch gegen die Leitungseinstellung.
	sl := Slots{AVDelay: Slot{NodeType: "omp-avdelay-pro", Video: true, Audio: true}, Converter: Slot{NodeType: "omp-udc-pro", Video: true, Strict: true}}
	ps := NodeParams(l, HouseFormat{}, sl)
	if last(ps, "avsync.mode") != "off" || last(ps, "normalize.mode") != "copyOnly" {
		t.Fatalf("Zwang fehlt: %v", ps)
	}
	// Converter ohne Strict: Normalizer bleibt Sicherheitsnetz.
	sl.Converter.Strict = false
	if v := last(NodeParams(l, HouseFormat{}, sl), "normalize.mode"); v != nil {
		t.Fatalf("ohne Strict kein copyOnly: %v", v)
	}
	// Start-Umgebung folgt demselben Schalter.
	if env, _ := normalizerEnv(l, HouseFormat{}, Slots{Converter: Slot{NodeType: "x", Video: true, Strict: true}}); env["OMP_NORMALIZE_MODE"] != "copyOnly" {
		t.Fatalf("env: %v", env)
	}
	if env, _ := normalizerEnv(l, HouseFormat{}, DefaultSlots()); env["OMP_NORMALIZE_MODE"] != "" {
		t.Fatalf("Standard-env: %v", env)
	}
}

func TestStagePortsOverride(t *testing.T) {
	cc := ChainConfig{Slots: Slots{AVDelay: Slot{NodeType: "omp-audio-delay", Audio: true, Ports: Ports{AudioIn: "Programm", AudioOut: "Programm verzögert"}}}}
	e := Event{ID: "ev", Name: "K", Lines: []Line{{ID: "l1", Name: "A", Kind: KindSRT, Transport: raw(`{"uri":"srt://:9000"}`)}}}
	def, _, _, err := Materialize(e, nil, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, c := range def.Connections {
		got[c.FromRole+":"+c.FromSender+">"+c.ToRole+":"+c.ToReceiver] = true
	}
	if !got["a-norm:Sender 2>a-post-avdelay:Programm"] {
		t.Fatalf("Ton in den Fremdnode fehlt: %v", got)
	}
	if got["a-norm:Sender 1>a-post-avdelay:Receiver 1"] {
		t.Fatalf("Bild darf nicht an den Ton-Node: %v", got)
	}
	m := def.Interface.Outputs[0].Members
	if m[0].Role != "a-norm" || m[0].Port != "Sender 1" || m[1].Role != "a-post-avdelay" || m[1].Port != "Programm verzögert" {
		t.Fatalf("Schnittstelle: %+v", m)
	}
}

package mcr

import (
	"strings"
	"testing"
)

func splitLine(normalize string, tracks string) Line {
	tr := `{"uri":"srt://:9000"}`
	if tracks != "" {
		tr = `{"existing":{"nodeLabel":"Quelle","audioTracks":` + tracks + `}}`
	}
	return Line{ID: "l1", Name: "Kam", Kind: KindMXL, Transport: raw(tr), Normalize: raw(normalize)}
}

func TestResolveAudioSplitTracksPairsExplicit(t *testing.T) {
	// Spuren: Namen und Hauskanäle der Reihe nach (Spur 1 zuerst).
	outs, err := ResolveAudioSplit(splitLine(`{"audioSplit":{"mode":"tracks"}}`, `[{"label":"Programm","channels":[1,2]},{"channels":[3,4]},{"label":"Kommentar","channels":[9]}]`), 16)
	if err != nil {
		t.Fatal(err)
	}
	want := []SplitOut{{"Programm", []int{1, 2}}, {"Spur 2", []int{3, 4}}, {"Kommentar", []int{5}}}
	if len(outs) != 3 {
		t.Fatalf("Ausgänge: %+v", outs)
	}
	for i, w := range want {
		if outs[i].Name != w.Name || len(outs[i].Channels) != len(w.Channels) || outs[i].Channels[0] != w.Channels[0] {
			t.Errorf("Ausgang %d: %+v, erwartet %+v", i, outs[i], w)
		}
	}
	// Paare
	outs, err = ResolveAudioSplit(splitLine(`{"audioSplit":{"mode":"pairs"}}`, ""), 5)
	if err != nil || len(outs) != 3 || outs[0].Name != "1/2" || outs[2].Name != "5" || len(outs[2].Channels) != 1 {
		t.Fatalf("Paare: %+v %v", outs, err)
	}
	// ausdrücklich
	outs, err = ResolveAudioSplit(splitLine(`{"audioSplit":{"outputs":[{"name":"Programm","channels":[1,2]},{"name":"IT","channels":[3,4]}]}}`, ""), 16)
	if err != nil || len(outs) != 2 {
		t.Fatalf("explizit: %+v %v", outs, err)
	}
	// nicht eingestellt
	for _, n := range []string{``, `{}`, `{"audioSplit":null}`, `{"audioSplit":{}}`, `{"mode":"auto"}`} {
		if o, err := ResolveAudioSplit(splitLine(n, ""), 16); o != nil || err != nil {
			t.Errorf("%q: kein Tonteiler erwartet, bekam %+v %v", n, o, err)
		}
	}
}

func TestResolveAudioSplitErrors(t *testing.T) {
	cases := map[string]struct {
		line  Line
		house int
		want  string
	}{
		"tracks ohne Spuren":  {splitLine(`{"audioSplit":{"mode":"tracks"}}`, ""), 16, "Tonspuren"},
		"pairs ohne Hauston":  {splitLine(`{"audioSplit":{"mode":"pairs"}}`, ""), 0, "Kanalzahl"},
		"Kanal über Hauston":  {splitLine(`{"audioSplit":{"outputs":[{"name":"A","channels":[1,17]}]}}`, ""), 16, "17"},
		"doppelter Name":      {splitLine(`{"audioSplit":{"outputs":[{"name":"A","channels":[1]},{"name":"A","channels":[2]}]}}`, ""), 16, "doppelt"},
		"doppelter Kanal":     {splitLine(`{"audioSplit":{"outputs":[{"name":"A","channels":[1,1]}]}}`, ""), 16, "doppelt"},
		"unbekannter Modus":   {splitLine(`{"audioSplit":{"mode":"alles"}}`, ""), 16, "unbekannt"},
		"mode und outputs":    {splitLine(`{"audioSplit":{"mode":"pairs","outputs":[{"name":"A","channels":[1]}]}}`, ""), 16, "nicht beides"},
		"leere Einstellung":   {splitLine(`{"audioSplit":{"mode":""}}`, ""), 16, "braucht"},
		"Spuren über Hauston": {splitLine(`{"audioSplit":{"mode":"tracks"}}`, `[{"channels":[1,2,3,4]}]`), 2, "Hauskanal"},
	}
	for name, c := range cases {
		_, err := ResolveAudioSplit(c.line, c.house)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: Fehler mit „%s“ erwartet, bekam %v", name, c.want, err)
		}
	}
	// Speichern wird schon in der Zeilenprüfung abgelehnt.
	l := splitLine(`{"audioSplit":{"mode":"alles"}}`, "")
	if err := validateLine(&l); err == nil {
		t.Error("validateLine muss einen ungültigen Tonteiler ablehnen")
	}
}

func TestMaterializeWithAudioSplit(t *testing.T) {
	g := mustHouse(t, `{"video":{"width":640,"height":360,"rate":"25/1","scan":"progressive"},"audio":{"sampleRate":48000,"channels":16}}`)
	l := splitLine(`{"audioSplit":{"outputs":[{"name":"Programm","channels":[1,2]},{"name":"IT","channels":[3,4]}]}}`, "")
	e := Event{ID: "ev", Name: "K", Lines: []Line{l}}
	def, roles, envs, err := Materialize(e, g, "", ChainConfig{})
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	for _, r := range def.Roles {
		types[r.Name] = r.NodeType
	}
	if types["kam-split"] != "omp-audio-split" {
		t.Fatalf("Rollen: %v", types)
	}
	got := map[string]bool{}
	for _, c := range def.Connections {
		got[c.FromRole+":"+c.FromSender+">"+c.ToRole+":"+c.ToReceiver] = true
	}
	if !got["kam-norm:Sender 2>kam-split:Receiver 1"] {
		t.Fatalf("Ton → Tonteiler fehlt: %v", got)
	}
	if env := envs["kam-split"]; !strings.Contains(env["OMP_SPLIT_OUTPUTS"], `"name":"Programm"`) || env["OMP_SPLIT_INPUT_CHANNELS"] != "16" {
		t.Fatalf("env: %v", env)
	}
	if roles["l1"].Split != "kam-split" || len(roles["l1"].SplitOutputs) != 2 {
		t.Fatalf("LineRoles: %+v", roles["l1"])
	}
	outs := map[string]string{}
	for _, o := range def.Interface.Outputs {
		for _, m := range o.Members {
			outs[o.Name] = m.Role + ":" + m.Port
		}
	}
	if outs["Kam · Programm"] != "kam-split:Programm" || outs["Kam · IT"] != "kam-split:IT" || outs["Kam"] == "" {
		t.Fatalf("Schnittstelle: %v", outs)
	}
	// Mit getrenntem A/V-Delay am Kettenende hängt der Tonteiler hinter dessen Ton-Ausgang.
	cc := ChainConfig{Slots: Slots{AVDelay: Slot{NodeType: "omp-avdelay", Video: true, Audio: true}}}
	def, _, _, err = Materialize(e, g, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	got = map[string]bool{}
	for _, c := range def.Connections {
		got[c.FromRole+":"+c.FromSender+">"+c.ToRole+":"+c.ToReceiver] = true
	}
	if !got["kam-post-avdelay:Sender 2>kam-split:Receiver 1"] {
		t.Fatalf("Tonteiler muss hinter dem A/V-Delay hängen: %v", got)
	}
	// Anderer Node-Typ im Slot (austauschbar) und eigener Eingangs-Port.
	cc = ChainConfig{Slots: Slots{Splitter: Slot{NodeType: "omp-split-pro", Audio: true, Ports: Ports{AudioIn: "Eingang"}}}}
	def, _, _, _ = Materialize(e, g, "", cc)
	ok := false
	for _, c := range def.Connections {
		ok = ok || (c.ToRole == "kam-split" && c.ToReceiver == "Eingang")
	}
	var typ string
	for _, r := range def.Roles {
		if r.Name == "kam-split" {
			typ = r.NodeType
		}
	}
	if !ok || typ != "omp-split-pro" {
		t.Fatalf("Slot Splitter: typ=%s ok=%v", typ, ok)
	}
	// Ohne Einstellung keine Zusatzrolle.
	e.Lines[0].Normalize = nil
	def, _, _, _ = Materialize(e, g, "", ChainConfig{})
	for _, r := range def.Roles {
		if strings.HasSuffix(r.Name, "-split") {
			t.Fatalf("ohne Einstellung kein Tonteiler: %v", r)
		}
	}
}

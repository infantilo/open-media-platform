package mcr

import (
	"encoding/json"
	"strings"
	"testing"
)

const matrixFull = `{"audioMatrix":{"inputs":[{"id":"in1","name":"Programm","channels":[{"label":"Links","symbol":"L"},{"label":"Rechts","symbol":"R"},"3","4"]},{"id":"in2","name":"Kommentar","channels":["Komm"]}],` +
	`"outputs":[{"id":"o1","name":"PGM 4","channels":["a","b","c","d"]},{"id":"o2","name":"Komm Mono","channels":["Komm"]}],` +
	`"routes":[{"out":"o1","ch":1,"in":"in1","inCh":1},{"out":"o1","ch":4,"in":"in2","inCh":1,"gainDb":-6},{"out":"o2","ch":1,"in":"in2","inCh":1}]}}`

func TestParseAudioMatrixForms(t *testing.T) {
	a, err := ParseAudioMatrix(splitLine(`{"audioMatrix":{"mode":"pairs"}}`, ""))
	if err != nil || a == nil || a.Mode != "pairs" || a.Config != nil {
		t.Fatalf("pairs: %+v %v", a, err)
	}
	a, err = ParseAudioMatrix(splitLine(matrixFull, ""))
	if err != nil || a == nil || a.Config == nil || len(a.Config.Inputs) != 2 || a.Config.Inputs[0].Channels[0].Symbol != "L" || a.Config.Inputs[0].Channels[2].Label != "3" {
		t.Fatalf("voll: %+v %v", a, err)
	}
	if a, err := ParseAudioMatrix(splitLine(`{"houseFormat":1}`, "")); a != nil || err != nil {
		t.Fatalf("ohne Einstellung: %v %v", a, err)
	}
	for name, n := range map[string]string{
		"leer":         `{"audioMatrix":{"foo":1}}`,
		"beides":       `{"audioMatrix":{"mode":"pairs","inputs":[]}}`,
		"mode":         `{"audioMatrix":{"mode":"alle"}}`,
		"kein-ausgang": `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":["1"]}]}}`,
		"symbol":       `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":[{"label":"x","symbol":"Q"}]}],"outputs":[{"id":"o","name":"O","channels":["1"]}]}}`,
		"kanal":        `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":["1"]}],"outputs":[{"id":"o","name":"O","channels":["1"]}],"routes":[{"out":"o","ch":2,"in":"a","inCh":1}]}}`,
		"gain":         `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":["1"]}],"outputs":[{"id":"o","name":"O","channels":["1"]}],"routes":[{"out":"o","ch":1,"in":"a","inCh":1,"gainDb":40}]}}`,
		"doppelt":      `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":["1"]}],"outputs":[{"id":"o","name":"O","channels":["1"]}],"routes":[{"out":"o","ch":1,"in":"a","inCh":1},{"out":"o","ch":1,"in":"a","inCh":1}]}}`,
		"name":         `{"audioMatrix":{"inputs":[{"id":"a","name":"A","channels":["1"]}],"outputs":[{"id":"o","name":"A","channels":["1"]},{"id":"p","name":"A","channels":["1"]}]}}`,
	} {
		if _, err := ParseAudioMatrix(splitLine(n, "")); err == nil {
			t.Errorf("%s: Fehler erwartet", name)
		}
	}
}

func TestResolveAudioMatrix(t *testing.T) {
	// pairs → ein Eingang mit 4 Hauskanälen, zwei Ausgänge, Kopierkreuzpunkte.
	c, err := ResolveAudioMatrix(splitLine(`{"audioMatrix":{"mode":"pairs"}}`, ""), 4)
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if len(c.Inputs) != 1 || len(c.Inputs[0].Channels) != 4 || len(c.Outputs) != 2 || c.Outputs[0].Name != "1/2" || len(c.Routes) != 4 {
		t.Fatalf("pairs: %+v", c)
	}
	// tracks aus den gewählten Tonspuren
	tracks := `[{"label":"Programm","channels":[1,2]},{"label":"Kommentar","channels":[1]}]`
	c, err = ResolveAudioMatrix(splitLine(`{"audioMatrix":{"mode":"tracks"}}`, tracks), 16)
	if err != nil || len(c.Outputs) != 2 || c.Outputs[1].Name != "Kommentar" || c.Routes[2].InCh != 3 || len(c.Inputs[0].Channels) != 16 {
		t.Fatalf("tracks: %+v %v", c, err)
	}
	// pairs ohne Hausformat-Kanalzahl → Fehler wie beim Teiler
	if _, err := ResolveAudioMatrix(splitLine(`{"audioMatrix":{"mode":"pairs"}}`, ""), 0); err == nil {
		t.Fatal("pairs ohne Kanalzahl muss scheitern")
	}
	// ausdrücklich: der erste Eingang darf nicht mehr Kanäle haben als der Haus-Ton
	if _, err := ResolveAudioMatrix(splitLine(matrixFull, ""), 2); err == nil || !strings.Contains(err.Error(), "Haus-Ton") {
		t.Fatalf("zu breit: %v", err)
	}
	c, err = ResolveAudioMatrix(splitLine(matrixFull, ""), 8)
	if err != nil || len(c.Routes) != 3 || c.Routes[1].GainDb == nil || *c.Routes[1].GainDb != -6 {
		t.Fatalf("voll: %+v %v", c, err)
	}
	// Die Umgebung ist wieder gültiges JSON der Konfiguration.
	var back MatrixConfig
	if err := json.Unmarshal([]byte(MatrixEnv(*c)["OMP_MATRIX_CONFIG"]), &back); err != nil || len(back.Outputs) != 2 || back.Inputs[0].Channels[0].Symbol != "L" {
		t.Fatalf("env: %v %+v", err, back)
	}
}

func TestMatrixAndSplitExclude(t *testing.T) {
	l := splitLine(`{"audioSplit":{"mode":"pairs"},"audioMatrix":{"mode":"pairs"}}`, "")
	if err := validateLine(&l); err == nil || !strings.Contains(err.Error(), "schließen sich aus") {
		t.Fatalf("Validate: %v", err)
	}
}

func TestMaterializeWithAudioMatrix(t *testing.T) {
	g := mustHouse(t, `{"video":{"width":640,"height":360,"rate":"25/1","scan":"progressive"},"audio":{"sampleRate":48000,"channels":8}}`)
	e := Event{ID: "ev", Name: "K", Lines: []Line{splitLine(matrixFull, "")}}
	def, roles, envs, err := Materialize(e, g, "", ChainConfig{})
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	for _, r := range def.Roles {
		types[r.Name] = r.NodeType
	}
	if types["kam-matrix"] != "omp-audio-matrix" {
		t.Fatalf("Rollen: %v", types)
	}
	got := map[string]bool{}
	for _, c := range def.Connections {
		got[c.FromRole+":"+c.FromSender+">"+c.ToRole+":"+c.ToReceiver] = true
	}
	if !got["kam-norm:Sender 2>kam-matrix:Programm"] {
		t.Fatalf("Ton → erster Matrix-Eingang fehlt: %v", got)
	}
	if !strings.Contains(envs["kam-matrix"]["OMP_MATRIX_CONFIG"], `"name":"PGM 4"`) {
		t.Fatalf("env: %v", envs["kam-matrix"])
	}
	if roles["l1"].Matrix != "kam-matrix" || len(roles["l1"].MatrixOutputs) != 2 || roles["l1"].Split != "" {
		t.Fatalf("LineRoles: %+v", roles["l1"])
	}
	outs := map[string]string{}
	for _, o := range def.Interface.Outputs {
		for _, m := range o.Members {
			outs[o.Name] = m.Role + ":" + m.Port
		}
	}
	if outs["Kam · PGM 4"] != "kam-matrix:PGM 4" || outs["Kam · Komm Mono"] != "kam-matrix:Komm Mono" || outs["Kam"] == "" {
		t.Fatalf("Schnittstelle: %v", outs)
	}
	// Austauschbar: anderer Node-Typ und eigener Eingangs-Port; getrennter A/V-Delay am Kettenende.
	cc := ChainConfig{Slots: Slots{Matrix: Slot{NodeType: "omp-matrix-pro", Audio: true, Ports: Ports{AudioIn: "Eingang"}}, AVDelay: Slot{NodeType: "omp-avdelay", Video: true, Audio: true}}}
	def, _, _, err = Materialize(e, g, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	ok := false
	for _, c := range def.Connections {
		ok = ok || (c.FromRole == "kam-post-avdelay" && c.ToRole == "kam-matrix" && c.ToReceiver == "Eingang")
	}
	var typ string
	for _, r := range def.Roles {
		if r.Name == "kam-matrix" {
			typ = r.NodeType
		}
	}
	if !ok || typ != "omp-matrix-pro" {
		t.Fatalf("Slot: typ=%s ok=%v", typ, ok)
	}
	// Ohne Einstellung keine Zusatzrolle.
	e.Lines[0].Normalize = nil
	def, _, _, _ = Materialize(e, g, "", ChainConfig{})
	for _, r := range def.Roles {
		if strings.HasSuffix(r.Name, "-matrix") {
			t.Fatalf("ohne Einstellung keine Matrix: %v", r)
		}
	}
}

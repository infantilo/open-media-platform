package ingest

import (
	"context"
	"strings"
	"testing"
)

func ip(i int) *int { return &i }

func mxf() Profile { return Profile{ID: "mxf-h264", Ext: ".mxf"} }

func TestValidateAudioPlan(t *testing.T) {
	prim := Source{InstanceID: "cam"}
	plan := func(inputs int, ch ...AudioChannel) *AudioPlan {
		p := &AudioPlan{Channels: ch}
		for i := 0; i < inputs; i++ {
			p.Inputs = append(p.Inputs, Source{InstanceID: "x" + string(rune('a'+i)), Label: "X"})
		}
		return p
	}
	cases := []struct {
		name string
		p    *AudioPlan
		prof Profile
		want string // Teilstring des ersten Problems, leer = ok
	}{
		{"kein Plan", nil, mxf(), ""},
		{"gültig, zwei Quellen", plan(1, AudioChannel{Input: ip(0), Channel: 1}, AudioChannel{Input: ip(1), GainDb: -6}, AudioChannel{}), mxf(), ""},
		{"nur Stille", plan(0, AudioChannel{}), mxf(), "kein Ausgabekanal ist mit einer Quelle belegt"},
		{"keine Kanäle", plan(0), mxf(), "keine Ausgabekanäle"},
		{"unbekannte Quelle", plan(0, AudioChannel{Input: ip(2)}), mxf(), "Quelle 2 gibt es nicht"},
		{"negativer Eingang", plan(0, AudioChannel{Input: ip(-1)}), mxf(), "gibt es nicht"},
		{"Gain zu hoch", plan(0, AudioChannel{Input: ip(0), GainDb: 40}), mxf(), "Gain"},
		{"Matroska max. 8", plan(0, make9()...), Profile{ID: "mkv", Ext: ".mkv"}, "höchstens 8"},
		{"MXF bis 32", plan(0, makeN(32)...), mxf(), ""},
		{"MXF über 32", plan(0, makeN(33)...), mxf(), "höchstens 32"},
		{"zu viele Quellen", plan(8, AudioChannel{Input: ip(0)}), mxf(), "höchstens 7 weitere"},
	}
	for _, c := range cases {
		probs := validateAudio(c.p, prim, c.prof, nil)
		switch {
		case c.want == "" && len(probs) > 0:
			t.Errorf("%s: unerwartet %v", c.name, probs)
		case c.want != "" && !strings.Contains(strings.Join(probs, "|"), c.want):
			t.Errorf("%s: erwartet %q, bekam %v", c.name, c.want, probs)
		}
	}
	// Kanalzahl bekannt: Kanal außerhalb wird früh gemeldet
	known := func(s Source) (int, bool) { return 2, s.InstanceID == "cam" }
	probs := validateAudio(plan(0, AudioChannel{Input: ip(0), Channel: 2}), prim, mxf(), known)
	if len(probs) != 1 || !strings.Contains(probs[0], "nur 2 Kanäle") {
		t.Errorf("Kanalzahl: %v", probs)
	}
}

func make9() []AudioChannel { return makeN(9) }
func makeN(n int) []AudioChannel {
	out := make([]AudioChannel, n)
	for i := range out {
		out[i] = AudioChannel{Input: ip(0), Channel: i % 2}
	}
	return out
}

func TestRecorderJSONAndLayout(t *testing.T) {
	p := &AudioPlan{Inputs: []Source{{InstanceID: "b", Label: "Kommentar"}}, Channels: []AudioChannel{
		{Input: ip(0), Channel: 1, GainDb: -3, Label: "L"}, {Input: ip(1)}, {Label: "leer"}}}
	got := p.RecorderJSON()
	for _, want := range []string{`"input":0`, `"channel":1`, `"gainDb":-3`, `"input":1`, `"input":null`} {
		if !strings.Contains(got, want) {
			t.Errorf("RecorderJSON %s fehlt in %s", want, got)
		}
	}
	if (*AudioPlan)(nil).RecorderJSON() != "" {
		t.Error("kein Plan → leer")
	}
	l := p.Layout()
	if len(l) != 3 || l[0]["inputChannel"] != 2 || l[1]["source"] != "Kommentar" || l[2]["silence"] != true {
		t.Errorf("Layout: %+v", l)
	}
	if keys := p.ExtraKeys(); len(keys) != 1 || keys[0] != "inst:b/" {
		t.Errorf("ExtraKeys: %v", keys)
	}
}

// Eine weitere Quelle zählt für Konflikt und Limit wie die Hauptquelle.
func TestExtraSourceConflictsLikePrimary(t *testing.T) {
	e := newIEnv(t, func(c *Config) { c.DefaultBudget.Hard[ResRecorders] = 4 })
	ctx := context.Background()
	e.cfg.Rules.SourceLimit = 1
	// A nimmt Kamera „shared“ als Hauptquelle auf
	a := e.adhoc(t, 10, 20, func(in *AdHocInput) { in.Source = Source{InstanceID: "shared", Label: "Shared"} })
	if a.State != StScheduled {
		t.Fatalf("A: %+v", a)
	}
	// B nimmt ein anderes Bild, nutzt „shared“ aber als weitere Audio-Quelle im selben Zeitraum → Konflikt
	st := a.PlannedStart
	_, d, err := e.svc.CreateAdHoc(ctx, AdHocInput{Name: "B", Source: Source{InstanceID: "other"}, Start: &st, DurationS: 600, ProfileID: "mxf-h264",
		Audio: &AudioPlan{Inputs: []Source{{InstanceID: "shared", Label: "Shared"}}, Channels: []AudioChannel{{Input: ip(0)}, {Input: ip(1)}}}}, "tester")
	if err != nil {
		t.Fatal(err)
	}
	if d.Admit || len(d.Verdicts) == 0 || d.Verdicts[0].Kind != VSourceConflict || !strings.Contains(d.Verdicts[0].Message, "Zusätzliche Audio-Quelle") {
		t.Fatalf("erwartet Quellenkonflikt über die weitere Quelle: %+v", d)
	}
	// Umgekehrt: C will „shared“ als Hauptquelle, während B (blockiert) nichts hält → frei außer A → ebenfalls Konflikt wegen A
	_, d2, _ := e.svc.CreateAdHoc(ctx, AdHocInput{Name: "C", Source: Source{InstanceID: "shared"}, Start: &st, DurationS: 600, ProfileID: "mxf-h264"}, "tester")
	if d2.Admit {
		t.Fatalf("C muss wegen A blockiert sein: %+v", d2)
	}
}

func TestAudioPlanReachesTheRecorderAndIsPersisted(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	plan := &AudioPlan{Inputs: []Source{{InstanceID: "mic", Label: "Sprecher"}}, Channels: []AudioChannel{
		{Input: ip(0), Channel: 1, Label: "Atmo R"}, {Input: ip(1), GainDb: -3, Label: "Sprecher"}, {Label: "frei"}}}
	j := e.adhoc(t, 5, 20, func(in *AdHocInput) { in.Audio = plan })
	if j.State != StScheduled || j.Audio == nil || len(j.Audio.Channels) != 3 {
		t.Fatalf("Auftrag: %+v", j)
	}
	got := e.job(t, j.ID)
	if got.Audio == nil || got.Audio.Channels[1].GainDb != -3 || got.Audio.Inputs[0].InstanceID != "mic" {
		t.Fatalf("Plan nicht gespeichert: %+v", got.Audio)
	}
	e.at(5)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	if g := e.job(t, j.ID); g.State != StRecording {
		t.Fatalf("Zustand %s (%s)", g.State, g.Error)
	}
	if e.rt.audioInputs != 2 {
		t.Errorf("Rekorder soll 2 Audio-Eingänge bekommen, hat %d", e.rt.audioInputs)
	}
	if e.rt.connectedAud == nil || e.rt.startedAud == nil || len(e.rt.startedAud.Channels) != 3 {
		t.Errorf("Plan beim Verbinden/Starten: %+v %+v", e.rt.connectedAud, e.rt.startedAud)
	}
	var sawMic bool
	for _, s := range e.rt.resolved {
		sawMic = sawMic || s.InstanceID == "mic"
	}
	if !sawMic {
		t.Error("die weitere Quelle muss auf Verfügbarkeit geprüft werden")
	}
}

func TestMissingExtraSourceWaitsLikeMissingPrimary(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	e.rt.extraDown = "Sprecher"
	j := e.adhoc(t, 5, 20, func(in *AdHocInput) {
		in.Audio = &AudioPlan{Inputs: []Source{{InstanceID: "mic", Label: "Sprecher"}}, Channels: []AudioChannel{{Input: ip(0)}, {Input: ip(1)}}}
	})
	e.at(5)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	g := e.job(t, j.ID)
	if g.State != StWaiting || !strings.Contains(g.Error, "Sprecher") {
		t.Fatalf("erwartet Warten auf die weitere Quelle, ist %s (%s)", g.State, g.Error)
	}
	e.rt.extraDown = ""
	e.at(6)
	e.svc.Step(ctx)
	e.svc.Step(ctx)
	if g := e.job(t, j.ID); g.State != StRecording {
		t.Fatalf("nach Rückkehr der Quelle: %s (%s)", g.State, g.Error)
	}
}

func TestScheduleEditKeepsAndChangesAudioPlan(t *testing.T) {
	e := newIEnv(t, nil)
	ctx := context.Background()
	in := ScheduleInput{Name: "S", Source: Source{InstanceID: "src1"}, ProfileID: "mxf-h264", Spec: Spec{TZ: "UTC", StartLocal: "2026-10-20T14:00", DurationS: 600},
		Audio: &AudioPlan{Channels: []AudioChannel{{Input: ip(0), Channel: 1}, {Input: ip(0), Channel: 0}}}}
	sc, err := e.svc.CreateSchedule(ctx, in, "tester")
	if err != nil {
		t.Fatal(err)
	}
	jobs, _ := e.svc.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID})
	if len(jobs) != 1 || jobs[0].Audio == nil || *jobs[0].Audio.Channels[0].Input != 0 || jobs[0].Audio.Channels[0].Channel != 1 {
		t.Fatalf("Auftrag erbt den Plan: %+v", jobs)
	}
	// Plan ändern (Kanäle vertauschen): bestehender Auftrag wird aktualisiert, nicht abgebrochen
	in.Audio = &AudioPlan{Channels: []AudioChannel{{Input: ip(0), Channel: 0}, {Input: ip(0), Channel: 1}, {}}}
	if _, err := e.svc.UpdateSchedule(ctx, sc.ID, in, sc.Revision, "tester"); err != nil {
		t.Fatal(err)
	}
	jobs, _ = e.svc.St.ListJobs(ctx, JobFilter{ScheduleID: sc.ID})
	if len(jobs) != 1 || jobs[0].State == StCancelled || len(jobs[0].Audio.Channels) != 3 {
		t.Fatalf("nach Änderung: %+v", jobs)
	}
	// ungültiger Plan wird abgelehnt
	in.Audio = &AudioPlan{Channels: []AudioChannel{{}}}
	cur, _ := e.svc.St.GetSchedule(ctx, sc.ID)
	if _, err := e.svc.UpdateSchedule(ctx, sc.ID, in, cur.Revision, "tester"); err == nil {
		t.Fatal("nur Stille muss abgelehnt werden")
	}
}

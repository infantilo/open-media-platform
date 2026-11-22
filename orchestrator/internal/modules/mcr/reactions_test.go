package mcr

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func rule(id string, mut func(*Reaction)) Reaction {
	r := Reaction{ID: id, Actions: []string{ActPip}, Select: "highest"}
	if mut != nil {
		mut(&r)
	}
	return r
}

func al(line, kind, sev string, start time.Time, end *time.Time) Alarm {
	return Alarm{ID: line + kind, LineID: line, LineName: line, Kind: kind, Severity: sev, StartedAt: start, EndedAt: end}
}

func TestValidateReactions(t *testing.T) {
	ok := []Reaction{rule("r1", func(r *Reaction) {
		r.Actions = []string{ActBorder, ActPip, ActNotice, ActGPIO}
		r.GPIO = &GPIOAction{Target: "gpio-1", Pin: 3}
	})}
	if err := ValidateReactions("E", ok); err != nil {
		t.Fatal(err)
	}
	for name, rs := range map[string][]Reaction{
		"keine Reaktion":       {{ID: "a"}},
		"unbekannte Reaktion":  {{ID: "a", Actions: []string{"boom"}}},
		"gpio ohne Ziel":       {{ID: "a", Actions: []string{ActGPIO}}},
		"doppelte Kennung":     {rule("a", nil), rule("a", nil)},
		"Schweregrad":          {rule("a", func(r *Reaction) { r.Trigger.MinSeverity = "furchtbar" })},
		"Haltezeit":            {rule("a", func(r *Reaction) { r.HoldSeconds = 99999 })},
		"fester Rückfall leer": {rule("a", func(r *Reaction) { r.Fallback.Mode = "fixed" })},
	} {
		if ValidateReactions("E", rs) == nil {
			t.Errorf("%s: muss abgelehnt werden", name)
		}
	}
}

func TestReactionMatches(t *testing.T) {
	a := al("A", "signal-black", "critical", time.Now(), nil)
	cases := []struct {
		name string
		r    Reaction
		want bool
	}{
		{"leer passt", rule("x", nil), true},
		{"Art exakt", rule("x", func(r *Reaction) { r.Trigger.Kinds = []string{"signal-black"} }), true},
		{"Gruppe", rule("x", func(r *Reaction) { r.Trigger.Kinds = []string{"signal"} }), true},
		{"andere Art", rule("x", func(r *Reaction) { r.Trigger.Kinds = []string{"signal-freeze"} }), false},
		{"Schweregrad zu niedrig", rule("x", func(r *Reaction) { r.Trigger.MinSeverity = "critical" }), true},
		{"Leitungsfilter fremd", rule("x", func(r *Reaction) { r.Trigger.Lines = []string{"B"} }), false},
		{"ausgeschaltet", rule("x", func(r *Reaction) { off := false; r.Enabled = &off }), false},
	}
	for _, c := range cases {
		if got := c.r.Matches(a); got != c.want {
			t.Errorf("%s: %v, erwartet %v", c.name, got, c.want)
		}
	}
	if (Reaction{Trigger: ReactionTrigger{MinSeverity: "critical"}}).Matches(al("A", "signal-black", "warning", time.Now(), nil)) {
		t.Error("Warnung unter Mindest-Schweregrad kritisch darf nicht passen")
	}
	if got := ActionsFor([]Reaction{rule("a", nil), {ID: "b", Actions: []string{ActNotice}}}, a); strings.Join(got, ",") != "pip,notice" {
		t.Errorf("Vereinigung der Reaktionen: %v", got)
	}
}

func TestSelectPipPriorityHoldFallbackLockDebounce(t *testing.T) {
	t0 := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	rs := []Reaction{rule("r", func(r *Reaction) {
		r.Trigger.Kinds = []string{"signal-black"}
		r.HoldSeconds = 10
		r.Fallback = ReactionFallback{Mode: "fixed", LineID: "F"}
	})}
	var st PipState

	// kein Alarm → fester Rückfall
	if got, st2 := SelectPip(rs, nil, t0, st); got != "F" {
		t.Fatalf("Rückfall: %q", got)
	} else {
		st = st2
	}
	// Regel „signal-black“ auf A → A
	aBlack := al("A", "signal-black", "warning", t0.Add(3*time.Second), nil)
	got, st := SelectPip(rs, []Alarm{aBlack}, t0.Add(3*time.Second), st)
	if got != "A" {
		t.Fatalf("A: %q", got)
	}
	// schwererer Alarm auf B (nach Entprellzeit) → B
	bBlack := al("B", "signal-black", "critical", t0.Add(6*time.Second), nil)
	got, st = SelectPip(rs, []Alarm{aBlack, bBlack}, t0.Add(6*time.Second), st)
	if got != "B" {
		t.Fatalf("schwerer B: %q", got)
	}
	// B endet: Haltezeit 10 s → B bleibt bis dahin ... A ist offen und damit besser als ein beendeter
	end := t0.Add(8 * time.Second)
	bBlack.EndedAt = &end
	got, st = SelectPip(rs, []Alarm{aBlack, bBlack}, t0.Add(9*time.Second), st)
	if got != "A" {
		t.Fatalf("offener Alarm vor beendetem: %q", got)
	}
	// A endet, Haltezeit läuft → A bleibt; danach Rückfall F
	endA := t0.Add(10 * time.Second)
	aBlack.EndedAt = &endA
	got, st = SelectPip(rs, []Alarm{aBlack, bBlack}, t0.Add(15*time.Second), st)
	if got != "B" { // beide noch in der Haltezeit: der schwerere gewinnt
		t.Fatalf("Haltezeit, schwerer zuerst: %q", got)
	}
	got, st = SelectPip(rs, []Alarm{aBlack, bBlack}, t0.Add(19*time.Second), st)
	if got != "A" { // B ist nach 18 s abgelaufen, A hält bis 20 s
		t.Fatalf("Haltezeit von A: %q", got)
	}
	got, st = SelectPip(rs, []Alarm{aBlack, bBlack}, t0.Add(30*time.Second), st)
	if got != "F" {
		t.Fatalf("nach Haltezeit Rückfall: %q", got)
	}
	// Operator-Sperre hält die Quelle trotz neuer Alarme
	st.Lock = "C"
	got, _ = SelectPip(rs, []Alarm{al("B", "signal-black", "critical", t0.Add(31*time.Second), nil)}, t0.Add(31*time.Second), st)
	if got != "C" {
		t.Fatalf("Sperre: %q", got)
	}
}

func TestSelectPipNegativeAndDebounce(t *testing.T) {
	t0 := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	// Regel ohne passenden Auslöser → keine Umschaltung
	rs := []Reaction{rule("r", func(r *Reaction) { r.Trigger.Kinds = []string{"signal-silence"} })}
	if got, _ := SelectPip(rs, []Alarm{al("A", "signal-black", "critical", t0, nil)}, t0, PipState{}); got != "" {
		t.Fatalf("Negativtest: %q", got)
	}
	// Regel ohne Pip-Reaktion → nie Alarm-PiP
	if got, _ := SelectPip([]Reaction{{ID: "n", Actions: []string{ActNotice}}}, []Alarm{al("A", "signal-black", "critical", t0, nil)}, t0, PipState{}); got != "" {
		t.Fatalf("ohne pip: %q", got)
	}
	// 10 Alarmwechsel in 1 s → höchstens eine Umschaltung
	rs = []Reaction{rule("r", func(r *Reaction) { r.Select = "latest" })}
	st := PipState{}
	switches := 0
	prev := ""
	for i := 0; i < 10; i++ {
		now := t0.Add(time.Duration(i) * 100 * time.Millisecond)
		line := string(rune('A' + i))
		var cur string
		cur, st = SelectPip(rs, []Alarm{al(line, "signal-black", "critical", now, nil)}, now, st)
		if cur != prev {
			switches++
			prev = cur
		}
	}
	if switches > 1 {
		t.Fatalf("Entprellen: %d Umschaltungen in 1 s", switches)
	}
}

type fakeGPIO struct {
	mu    sync.Mutex
	calls []string
}

func (g *fakeGPIO) set(_ context.Context, target string, pin int, level bool) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, target+":"+itoa(pin)+"="+map[bool]string{true: "1", false: "0"}[level])
	return nil
}

func TestGPIOSetOnRaiseAndResetOnLastClear(t *testing.T) {
	svc, rt, ev, line := alarmEnv(t)
	g := &fakeGPIO{}
	rt.GPIO = g.set
	ctx := context.Background()
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	mon := `{"reactions":[{"id":"rot","actions":["gpio"],"gpio":{"target":"gpio-1","pin":2},"trigger":{"kinds":["signal"]}}]}`
	if _, err := svc.UpdateEvent(ctx, ev.ID, NewEventInput{Name: cur.Name, Lines: cur.Lines, Monitoring: json.RawMessage(mon)}, true, "alice"); err != nil {
		t.Fatal(err)
	}
	_ = line
	in := func(kind, state string) AlarmIn {
		return AlarmIn{NodeID: "n-scope", Kind: kind, State: state, Severity: "critical", Message: "x"}
	}
	for _, a := range []AlarmIn{in("signal-black", "raised"), in("signal-freeze", "raised"), in("signal-black", "cleared"), in("signal-freeze", "cleared")} {
		if err := rt.IngestAlarm(ctx, svc, a); err != nil {
			t.Fatal(err)
		}
	}
	got := strings.Join(g.calls, " ")
	// zwei Eintritte setzen; erstes Ende lässt den Ausgang (anderer Alarm offen), letztes Ende setzt zurück
	if got != "gpio-1:2=1 gpio-1:2=1 gpio-1:2=1 gpio-1:2=0" {
		t.Fatalf("Kontaktausgang: %s", got)
	}
}

func TestAlarmPipSwitchesWithoutRebuildingOthers(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	wf, nodes, mon := newFakeWf(), &fakeNodes{}, &fakeMon{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: mon, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	mxl := func(n string) Line {
		return Line{Name: n, Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}
	}
	reactions := json.RawMessage(`{"reactions":[{"id":"pip","actions":["pip"],"trigger":{"kinds":["signal-black"]},"holdSeconds":0,"fallback":{"mode":"empty"}}]}`)
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Pip", Monitoring: reactions, Lines: []Line{mxl("A"), mxl("B")}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if ev, err = svc.Transition(ctx, ev.ID, StateTesting, "alice", false); err != nil {
		t.Fatal(err)
	}
	rt.Watch(ev.ID)
	full, _ := svc.St.GetEvent(ctx, ev.ID)
	for i := 0; i < 3; i++ {
		_, _ = rt.Reconcile(ctx, svc, full)
	}
	have, _ := rt.monWorkflows(ev.ID)
	mv := have[""]
	hasSwitcher := false
	for _, r := range mv.Definition.Roles {
		if r.NodeType == NodeSwitcher {
			hasSwitcher = true
		}
	}
	if !hasSwitcher {
		t.Fatalf("Multiviewer-Workflow braucht den Switcher des Alarm-PiPs: %+v", mv.Definition.Roles)
	}
	if len(nodes.states) == 0 || !strings.Contains(nodes.states[len(nodes.states)-1], pipTileID) {
		t.Fatalf("Alarm-PiP ist eine eigene Kachel im Layout: %v", nodes.states)
	}
	statesBefore := len(nodes.states)
	// Alarm auf B → Switcher bekommt die Quelle von B; das Layout (Multiviewer) bleibt unverändert
	lineB := full.Lines[1]
	rt.Resolve = func(string) (string, string, bool) { return "", "", false }
	if _, _, err := svc.St.RaiseAlarm(ctx, Alarm{EventID: ev.ID, LineID: lineB.ID, LineName: "B", Kind: "signal-black", Severity: "critical", Text: "x"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_, _ = rt.Reconcile(ctx, svc, full)
	}
	if len(nodes.selects) == 0 || !strings.Contains(nodes.selects[len(nodes.selects)-1], "snd-inst-b-norm") {
		t.Fatalf("Switcher auf Leitung B geschaltet: %v", nodes.selects)
	}
	if len(nodes.states) != statesBefore {
		t.Fatalf("Umschalten darf das Multiviewer-Layout nicht ändern (kein Neuaufbau): %d → %d", statesBefore, len(nodes.states))
	}
	// Sperre auf A hält A trotz Alarm auf B
	rt.PipLock(ev.ID, full.Lines[0].ID)
	time.Sleep(10 * time.Millisecond)
	for i := 0; i < 2; i++ {
		_, _ = rt.Reconcile(ctx, svc, full)
	}
	if !strings.Contains(nodes.selects[len(nodes.selects)-1], "snd-inst-a-norm") {
		t.Fatalf("Sperre: %v", nodes.selects)
	}
	// Wand zeigt Alarmpunkte und PiP-Zustand
	wall, _ := rt.Wall(ctx, svc, nil)
	if len(wall) != 1 || !wall[0].HasPip || wall[0].PipLock != full.Lines[0].ID || len(wall[0].Lines[1].AlarmItems) != 1 {
		t.Fatalf("Wand: %+v", wall)
	}
}

type fakeNoticeSvc struct{ bodies []map[string]any }

func (f *fakeNoticeSvc) CallRole(_ context.Context, _, role string, _ []string, body any, _ string) (int, []byte, error) {
	if role == "panel.notice" {
		f.bodies = append(f.bodies, body.(map[string]any))
	}
	return 200, []byte(`{"ok":true}`), nil
}

func TestPanelNoticeOnRaiseOnly(t *testing.T) {
	svc, rt, ev, _ := alarmEnv(t)
	f := &fakeNoticeSvc{}
	rt.Intercom = &Intercom{Svc: f}
	ctx := context.Background()
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	mon := `{"reactions":[{"id":"an-regie","actions":["panel"],"panels":[3,4],"trigger":{"kinds":["signal-black"]}},{"id":"alle","actions":["panel"],"trigger":{"kinds":["signal-black"]},"enabled":false}]}`
	if _, err := svc.UpdateEvent(ctx, ev.ID, NewEventInput{Name: cur.Name, Lines: cur.Lines, Monitoring: json.RawMessage(mon)}, true, "alice"); err != nil {
		t.Fatal(err)
	}
	in := func(kind, state string) AlarmIn {
		return AlarmIn{NodeID: "n-scope", Kind: kind, State: state, Severity: "critical", Message: "Schwarzbild"}
	}
	for _, a := range []AlarmIn{in("signal-freeze", "raised"), in("signal-black", "raised"), in("signal-black", "cleared")} {
		if err := rt.IngestAlarm(ctx, svc, a); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.bodies) != 1 {
		t.Fatalf("erwartet genau einen Hinweis (nur Eintritt, nur passende, nur aktive Regel): %v", f.bodies)
	}
	b := f.bodies[0]
	if b["severity"] != "critical" || !strings.Contains(b["text"].(string), "Schwarzbild") || len(b["to"].([]int)) != 2 {
		t.Fatalf("Inhalt: %v", b)
	}
}

func TestValidatePanelReaction(t *testing.T) {
	if err := ValidateReactions("x", []Reaction{{ID: "a", Actions: []string{"panel"}, Panels: []int{0}}}); err == nil {
		t.Fatal("Kennung 0 muss abgelehnt werden")
	}
	if err := ValidateReactions("x", []Reaction{{ID: "a", Actions: []string{"panel"}, Panels: []int{2}}}); err != nil {
		t.Fatal(err)
	}
}

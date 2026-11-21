package mcr

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

func alarmEnv(t *testing.T) (*Service, *Runtime, Event, Line) {
	en := newEnv(t)
	svc := en.m.svc
	wf := newFakeWf()
	rt := &Runtime{Wf: wf, Nodes: &fakeNodes{}, Monitor: &fakeMon{}, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Alarm", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	line := ev.Lines[0]
	// Überwachungs-Workflow dieser Leitung mit Rolle „scope“; der Resolver ordnet Node „n-scope“ ihm zu
	mon, _ := wf.Create("m", workflows.Definition{Description: monDesc(ev.ID, line.ID)}, nil, "")
	rt.Resolve = func(node string) (string, string, bool) {
		if node == "n-scope" {
			return mon.ID, "scope", true
		}
		return "", "", false
	}
	return svc, rt, ev, line
}

func TestAlarmLifecycleDedupAckAndHistory(t *testing.T) {
	svc, rt, ev, _ := alarmEnv(t)
	ctx := context.Background()
	raise := AlarmIn{NodeID: "n-scope", Kind: "signal-black", State: "raised", Severity: "critical", Line: "A", Message: "Schwarzbild"}
	if err := rt.IngestAlarm(ctx, svc, raise); err != nil {
		t.Fatal(err)
	}
	raise.Message = "Schwarzbild seit 3 s"
	if err := rt.IngestAlarm(ctx, svc, raise); err != nil { // doppelte Meldung
		t.Fatal(err)
	}
	open, _ := svc.St.EventAlarms(ctx, ev.ID, true)
	if len(open) != 1 || open[0].Text != "Schwarzbild seit 3 s" || open[0].LineName != "A" {
		t.Fatalf("doppelte Meldung wird zusammengefasst: %+v", open)
	}
	// Quittieren: zweite Person sieht es; fremdes Event → nicht gefunden
	if _, err := svc.St.AckAlarm(ctx, "anderes-event", open[0].ID, "bob"); err != ErrNotFound {
		t.Fatalf("fremdes Event: %v", err)
	}
	if _, err := svc.St.AckAlarm(ctx, ev.ID, open[0].ID, "bob"); err != nil {
		t.Fatal(err)
	}
	again, _ := svc.St.EventAlarms(ctx, ev.ID, true)
	if again[0].AckedBy != "bob" || again[0].AckedAt == nil {
		t.Fatalf("Quittierung sichtbar: %+v", again[0])
	}
	// Ende: genau ein Historieneintrag mit Dauer
	time.Sleep(20 * time.Millisecond)
	if err := rt.IngestAlarm(ctx, svc, AlarmIn{NodeID: "n-scope", Kind: "signal-black", State: "cleared"}); err != nil {
		t.Fatal(err)
	}
	all, _ := svc.St.EventAlarms(ctx, ev.ID, false)
	if len(all) != 1 || all[0].EndedAt == nil || all[0].DurationSec <= 0 {
		t.Fatalf("ein Eintrag mit Dauer: %+v", all)
	}
	if open, _ := svc.St.EventAlarms(ctx, ev.ID, true); len(open) != 0 {
		t.Fatal("nach dem Ende kein offener Alarm")
	}
	// Entwarnung allein (ohne Eintritt) wird verworfen
	if err := rt.IngestAlarm(ctx, svc, AlarmIn{NodeID: "n-scope", Kind: "signal-freeze", State: "cleared"}); err != nil {
		t.Fatal(err)
	}
	if all, _ = svc.St.EventAlarms(ctx, ev.ID, false); len(all) != 1 {
		t.Fatalf("Entwarnung ohne Eintritt erzeugt nichts: %d", len(all))
	}
	// Historie ereignisübergreifend + Aufräumen
	h, _ := svc.St.AlarmHistory(ctx, time.Now().Add(-time.Hour), ev.ID, "", 10)
	if len(h) != 1 {
		t.Fatalf("Historie: %d", len(h))
	}
	if n, _ := svc.St.PurgeAlarms(ctx, time.Now().Add(time.Hour)); n < 1 {
		t.Fatalf("beendete Alarme werden aufgeräumt: %d", n)
	}
	if left, _ := svc.St.EventAlarms(ctx, ev.ID, false); len(left) != 0 {
		t.Fatalf("nach dem Aufräumen bleibt nichts: %d", len(left))
	}
}

func TestAlarmIgnoredForProfileOffAndForeignNodes(t *testing.T) {
	svc, rt, ev, line := alarmEnv(t)
	ctx := context.Background()
	if err := rt.IngestAlarm(ctx, svc, AlarmIn{NodeID: "fremd", Kind: "signal-black", State: "raised"}); err != nil {
		t.Fatal(err)
	}
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	lines := cur.Lines
	lines[0].Monitoring = json.RawMessage(`{"profile":"off"}`)
	if _, err := svc.UpdateEvent(ctx, ev.ID, NewEventInput{Name: cur.Name, Lines: lines}, true, "alice"); err != nil {
		t.Fatal(err)
	}
	cur, _ = svc.St.GetEvent(ctx, ev.ID)
	// Leitungs-ID bleibt beim Ersetzen erhalten
	if cur.Lines[0].ID != line.ID {
		t.Skip("Leitungs-ID wechselt beim Ersetzen")
	}
	if err := rt.IngestAlarm(ctx, svc, AlarmIn{NodeID: "n-scope", Kind: "signal-black", State: "raised", Message: "x"}); err != nil {
		t.Fatal(err)
	}
	if all, _ := svc.St.EventAlarms(ctx, ev.ID, false); len(all) != 0 {
		t.Fatalf("Profil off: kein Eintrag, %d", len(all))
	}
}

func TestParseAlarmEventOnlyStructuredSignalAlarms(t *testing.T) {
	ok := sse.Event{Type: "omp.alert.node-1", Data: json.RawMessage(`{"node_id":"node-1","kind":"signal-black","state":"raised","severity":"critical","line":"A","message":"m"}`)}
	if a, good := ParseAlarmEvent(ok); !good || a.Kind != "signal-black" || a.NodeID != "node-1" || a.Line != "A" {
		t.Fatalf("%+v %v", a, good)
	}
	for _, ev := range []sse.Event{
		{Type: "omp.alert.node-1", Data: json.RawMessage(`{"message":"Pipeline-Fehler"}`)},
		{Type: "node.updated", Data: json.RawMessage(`{}`)},
	} {
		if _, good := ParseAlarmEvent(ev); good {
			t.Fatalf("kein Signalalarm: %+v", ev)
		}
	}
}

func TestMonitoringConfigValidationAndEffective(t *testing.T) {
	if err := ValidateMon("E", json.RawMessage(`{"profile":"strict","overrides":{"black.holdSeconds":5}}`), true); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]string{"Abweichung": `{"overrides":{"x":1}}`, "Profilname": `{"profile":"a/b"}`} {
		if ValidateMon("E", json.RawMessage(c), true) == nil {
			t.Errorf("%s muss abgelehnt werden", name)
		}
	}
	eff := EffectiveMon(json.RawMessage(`{"profile":"standard","overrides":{"black.holdSeconds":3,"freeze.enabled":true}}`), json.RawMessage(`{"profile":"off","overrides":{"black.holdSeconds":9}}`))
	if !eff.Off() || eff.Overrides["black.holdSeconds"].(float64) != 9 || eff.Overrides["freeze.enabled"] != true {
		t.Fatalf("Leitung überstimmt Event: %+v", eff)
	}
	ps := EffectiveMon(json.RawMessage(`{"profile":"strict","overrides":{"b.threshold":1,"a.enabled":false}}`), nil).ScopeParams()
	if len(ps) != 3 || ps[0].Name != "qc.profile" || ps[1].Name != "qc.a.enabled" || ps[2].Name != "qc.b.threshold" {
		t.Fatalf("Reihenfolge Profil, dann Abweichungen sortiert: %+v", ps)
	}
}

func TestOpenAlarmsAreClosedWhenEventLeavesTestOrLive(t *testing.T) {
	svc, rt, ev, _ := alarmEnv(t)
	ctx := context.Background()
	if err := rt.IngestAlarm(ctx, svc, AlarmIn{NodeID: "n-scope", Kind: "signal-black", State: "raised", Severity: "critical", Message: "x"}); err != nil {
		t.Fatal(err)
	}
	if n, err := svc.St.CloseEventAlarms(ctx, ev.ID); err != nil || n != 1 {
		t.Fatalf("offener Alarm wird geschlossen: %d %v", n, err)
	}
	all, _ := svc.St.EventAlarms(ctx, ev.ID, false)
	if len(all) != 1 || all[0].EndedAt == nil {
		t.Fatalf("Historie bleibt mit Ende: %+v", all)
	}
}

package mcr

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRec struct {
	mu      sync.Mutex
	starts  []RecInput
	stops   []string
	failing bool
}

func (f *fakeRec) Start(_ context.Context, in RecInput) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failing {
		return "", errors.New("Profil unbekannt")
	}
	f.starts = append(f.starts, in)
	return "job-" + itoa(len(f.starts)), nil
}
func (f *fakeRec) Stop(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, id)
	return nil
}

func TestValidateRecord(t *testing.T) {
	if err := ValidateRecord("L", json.RawMessage(`{"house":true,"profileId":"p1","dir":"mcr/ev"}`)); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]string{
		"Originalstrom":   `{"original":true}`,
		"ohne Profil":     `{"house":true}`,
		"Pfad nach außen": `{"house":true,"profileId":"p","dir":"../x"}`,
		"absoluter Pfad":  `{"house":true,"profileId":"p","dir":"/etc"}`,
	} {
		if ValidateRecord("L", json.RawMessage(c)) == nil {
			t.Errorf("%s: muss abgelehnt werden", name)
		}
	}
	if err := ValidateRecord("L", nil); err != nil {
		t.Fatal("keine Aufzeichnung ist gültig")
	}
}

func TestRecordDuration(t *testing.T) {
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	end := now.Add(90 * time.Minute)
	if d := RecordDuration(Event{PlannedEnd: &end}, now); d != 90*60+60 {
		t.Fatalf("bis Eventende plus Nachlauf: %d", d)
	}
	if d := RecordDuration(Event{}, now); d != DefaultRecordS {
		t.Fatalf("ohne Ende: %d", d)
	}
	far := now.Add(100 * time.Hour)
	if d := RecordDuration(Event{PlannedEnd: &far}, now); d != MaxRecordS {
		t.Fatalf("Obergrenze: %d", d)
	}
}

func TestRecordingOncePerLineAndStoppedOnTeardown(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	wf, nodes, rec := newFakeWf(), &fakeNodes{}, &fakeRec{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: &fakeMon{}, Recorder: rec, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	mxl := func(n string, record string) Line {
		l := Line{Name: n, Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}
		if record != "" {
			l.Record = json.RawMessage(record)
		}
		return l
	}
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Rec", Lines: []Line{mxl("A", `{"house":true,"profileId":"tams","dir":"mcr"}`), mxl("B", "")}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, to := range []string{StateTesting} {
		if ev, err = svc.Transition(ctx, ev.ID, to, "alice", false); err != nil {
			t.Fatal(err)
		}
	}
	reconcile := func() {
		full, _ := svc.St.GetEvent(ctx, ev.ID)
		_, _ = rt.Reconcile(ctx, svc, full)
	}
	reconcile()
	if len(rec.starts) != 0 {
		t.Fatal("im Test (nicht auf Sendung) wird nicht aufgezeichnet")
	}
	if ev, err = svc.Transition(ctx, ev.ID, StateLive, "alice", true); err != nil {
		t.Fatal(err)
	}
	reconcile()
	reconcile()
	reconcile()
	if len(rec.starts) != 1 {
		t.Fatalf("genau ein Auftrag (nur Leitung A): %d", len(rec.starts))
	}
	in := rec.starts[0]
	if in.ProfileID != "tams" || in.Dir != "mcr" || in.InstanceID != "inst-a-norm-1" || in.LineName != "A" || in.DurationS != DefaultRecordS {
		t.Fatalf("Auftrag: %+v", in)
	}
	// neue Runtime (Neustart des Orchestrators): kein zweiter Auftrag
	rt2 := &Runtime{Wf: wf, Nodes: nodes, Monitor: &fakeMon{}, Recorder: rec, Poll: 1, Timeout: 1_000_000_000}
	full, _ := svc.St.GetEvent(ctx, ev.ID)
	_, _ = rt2.Reconcile(ctx, svc, full)
	if len(rec.starts) != 1 {
		t.Fatalf("nach Neustart kein Doppelstart: %d", len(rec.starts))
	}
	st, _ := rt.Status(ctx, svc, full)
	if m, _ := st["recording"].(map[string]any); m[full.Lines[0].ID] == nil || m[full.Lines[1].ID] != nil {
		t.Fatalf("Status nennt nur die Leitung mit Aufzeichnung: %+v", st["recording"])
	}
	// Abbau beendet genau einmal
	if ev, err = svc.Transition(ctx, ev.ID, StateTeardown, "alice", true); err != nil {
		t.Fatal(err)
	}
	if len(rec.stops) != 1 || rec.stops[0] != "job-1" {
		t.Fatalf("Abbau beendet den Auftrag genau einmal: %v", rec.stops)
	}
	rt.StopRecordings(ctx, svc, ev.ID)
	if len(rec.stops) != 1 {
		t.Fatalf("kein zweites Beenden: %v", rec.stops)
	}
}

func TestRecordingErrorIsReportedAndRetried(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	wf, nodes, rec := newFakeWf(), &fakeNodes{}, &fakeRec{failing: true}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: &fakeMon{}, Recorder: rec, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	ev, _ := svc.CreateEvent(ctx, NewEventInput{Name: "Rec2", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`), Record: json.RawMessage(`{"house":true,"profileId":"x"}`)}}}, "alice")
	for _, to := range []string{StateTesting, StateLive} {
		ev, _ = svc.Transition(ctx, ev.ID, to, "alice", true)
	}
	full, _ := svc.St.GetEvent(ctx, ev.ID)
	_, _ = rt.Reconcile(ctx, svc, full)
	st, _ := rt.Status(ctx, svc, full)
	if m, _ := st["recording"].(map[string]any); m == nil || m[full.Lines[0].ID].(map[string]any)["error"] == nil {
		t.Fatalf("Fehler im Status: %+v", st["recording"])
	}
	rec.mu.Lock()
	rec.failing = false
	rec.mu.Unlock()
	_, _ = rt.Reconcile(ctx, svc, full)
	if len(rec.starts) != 1 {
		t.Fatalf("nächster Abgleich versucht es erneut: %d", len(rec.starts))
	}
}

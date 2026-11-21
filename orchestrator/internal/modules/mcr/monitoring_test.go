package mcr

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

func TestPlanMonitoring(t *testing.T) {
	p := PlanMonitoring([]string{"a", "b"}, map[string]bool{}, true)
	if strings.Join(p.Create, ",") != ",a,b" || len(p.Remove) != 0 {
		t.Fatalf("neu: %+v", p)
	}
	p = PlanMonitoring([]string{"a", "b", "c"}, map[string]bool{"": true, "a": true, "b": true}, true)
	if strings.Join(p.Create, ",") != "c" || len(p.Remove) != 0 {
		t.Fatalf("dritte Leitung ändert nur diese: %+v", p)
	}
	p = PlanMonitoring([]string{"a"}, map[string]bool{"": true, "a": true, "b": true}, true)
	if len(p.Create) != 0 || strings.Join(p.Remove, ",") != "b" {
		t.Fatalf("Leitung entfernt: %+v", p)
	}
	p = PlanMonitoring(nil, map[string]bool{"": true, "a": true}, true)
	if strings.Join(p.Remove, ",") != ",a" {
		t.Fatalf("keine Leitung, keine Überwachung: %+v", p)
	}
}

type fakeMon struct {
	mu    sync.Mutex
	links []string
}

func (f *fakeMon) NodeID(inst string) (string, bool)      { return "node-" + inst, true }
func (f *fakeMon) VideoSender(inst string) (string, bool) { return "snd-" + inst, true }
func (f *fakeMon) LinkInstances(_ context.Context, from, _, to string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links = append(f.links, from+">"+to)
	return nil
}

func TestMonitoringFollowsLines(t *testing.T) {
	e := newEnv(t)
	wf, nodes, mon := newFakeWf(), &fakeNodes{}, &fakeMon{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: mon, Poll: 1, Timeout: 1_000_000_000}
	e.m.svc.Run, e.m.rt = rt, rt
	svc := e.m.svc
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	mxl := func(n string) Line {
		return Line{Name: n, Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}
	}
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Mon", Lines: []Line{mxl("A"), mxl("B")}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if ev, err = svc.Transition(ctx, ev.ID, StateTesting, "alice", false); err != nil {
		t.Fatal(err)
	}
	reconcile := func() Event {
		full, _ := svc.St.GetEvent(ctx, ev.ID)
		if _, err := rt.Reconcile(ctx, svc, full); err != nil {
			t.Fatal(err)
		}
		return full
	}
	count := func() map[string]workflows.Workflow { m, _ := rt.monWorkflows(ev.ID); return m }

	rt.Watch(ev.ID)
	reconcile() // legt die Workflows an und startet sie
	reconcile() // Instanzen sind da: verbinden und Zustand senden
	if got := count(); len(got) != 3 {
		t.Fatalf("Multiviewer + 2 Scopes erwartet, %d", len(got))
	}
	if len(mon.links) != 2 {
		t.Fatalf("je Leitung ein Scope verbunden: %v", mon.links)
	}
	if len(nodes.states) != 1 || strings.Count(nodes.states[0], `"senderId"`) != 2 {
		t.Fatalf("Multiviewer-Zustand mit 2 Kacheln: %v", nodes.states)
	}
	// niemand sieht zu: der Multiviewer verschwindet, die Scopes bleiben
	rt.mu.Lock()
	rt.watch = map[string]time.Time{ev.ID: time.Now().Add(-time.Hour)}
	rt.mu.Unlock()
	reconcile()
	if got := count(); len(got) != 2 || got[""].ID != "" {
		t.Fatalf("ohne Zuschauer nur die 2 Scopes, %d", len(got))
	}
	rt.Watch(ev.ID)
	reconcile()
	reconcile()
	// unverändert: nichts erneut verbinden/senden
	reconcile()
	if len(mon.links) != 2 || len(nodes.states) != 1 {
		t.Fatalf("keine Wiederholung: %v %v", mon.links, nodes.states)
	}
	// dritte Leitung zufügen: nur deren Workflow kommt dazu, die beiden Scopes bleiben dieselben Workflows
	before := map[string]string{}
	for k, w := range count() {
		before[k] = w.ID
	}
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	lines := append(append([]Line{}, cur.Lines...), mxl("C"))
	if _, err := svc.UpdateEvent(ctx, ev.ID, NewEventInput{Name: cur.Name, Lines: lines}, true, "alice"); err != nil {
		t.Fatal(err)
	}
	reconcile()
	reconcile()
	after := count()
	if len(after) != 4 {
		t.Fatalf("4 Workflows erwartet, %d", len(after))
	}
	for k, id := range before {
		if after[k].ID != id {
			t.Fatalf("Workflow %q wurde angefasst", k)
		}
	}
	if len(mon.links) != 3 {
		t.Fatalf("nur die neue Leitung wird verbunden: %v", mon.links)
	}
	if wf.reshapes != 1 {
		t.Fatalf("die neue Leitung kommt über Reshape in den laufenden Workflow: %d", wf.reshapes)
	}
	// Abbau: keine Überwachung mehr
	if _, err := svc.Transition(ctx, ev.ID, StatePlanned, "alice", false); err != nil {
		t.Fatal(err)
	}
	if got := count(); len(got) != 0 {
		t.Fatalf("nach Rücknahme bleibt nichts übrig: %d", len(got))
	}
}

func TestMonitorEnvOnlyForScopeOfMonitoringWorkflow(t *testing.T) {
	d := workflows.Definition{Description: MonPrefix + "ev"}
	if MonitorEnv(d, workflows.Role{NodeType: NodeScope})["OMP_SCOPE_MODE"] != "monitor" {
		t.Fatal("Scope der Überwachung läuft im Überwachungsmodus")
	}
	if MonitorEnv(d, workflows.Role{NodeType: NodeMultiviewer}) != nil || MonitorEnv(workflows.Definition{Description: "x"}, workflows.Role{NodeType: NodeScope}) != nil {
		t.Fatal("kein Eingriff bei anderen Rollen/Workflows")
	}
}

func TestSweepOrphansRemovesWorkflowsOfGoneOrPlannedEvents(t *testing.T) {
	e := newEnv(t)
	wf := newFakeWf()
	rt := &Runtime{Wf: wf, Nodes: &fakeNodes{}, Monitor: &fakeMon{}}
	e.m.svc.Run, e.m.rt = rt, rt
	ctx := context.Background()
	ev, err := e.m.svc.CreateEvent(ctx, NewEventInput{Name: "X", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}}}, "a")
	if err != nil {
		t.Fatal(err)
	}
	// Event geplant, aber eine Überwachung läuft noch → weg; Event gelöscht → auch sein Event-Workflow weg
	mon, _ := wf.Create("m", workflows.Definition{Description: monDesc(ev.ID, "l1")}, nil, "")
	_ = wf.Start(ctx, mon.ID)
	gone, _ := wf.Create("g", workflows.Definition{Description: DescriptionPrefix + "gibt-es-nicht"}, nil, "")
	keep, _ := wf.Create("k", workflows.Definition{Description: DescriptionPrefix + ev.ID}, nil, "")
	rt.sweepOrphans(ctx, e.m.svc) // 1. Lauf: anhalten bzw. löschen
	rt.sweepOrphans(ctx, e.m.svc) // 2. Lauf: gestoppte löschen
	if _, err := wf.Get(mon.ID); err == nil {
		t.Fatal("Überwachung eines geplanten Events muss verschwinden")
	}
	if _, err := wf.Get(gone.ID); err == nil {
		t.Fatal("Workflow eines gelöschten Events muss verschwinden")
	}
	if _, err := wf.Get(keep.ID); err != nil {
		t.Fatal("Event-Workflow eines vorhandenen (geplanten) Events bleibt")
	}
}

func TestSortWallPutsAlarmsFirst(t *testing.T) {
	now := time.Now()
	later := now.Add(time.Hour)
	evs := []WallEvent{
		{ID: "plan", State: StatePlanned, PlannedStart: &later},
		{ID: "ok-live", State: StateLive, Level: AlarmOK},
		{ID: "bad-test", State: StateTesting, Level: AlarmBad},
		{ID: "warn-live", State: StateLive, Level: AlarmWarn},
		{ID: "ok-test", State: StateTesting, Level: AlarmOK},
	}
	SortWall(evs)
	got := []string{}
	for _, e := range evs {
		got = append(got, e.ID)
	}
	if strings.Join(got, ",") != "bad-test,warn-live,ok-live,ok-test,plan" {
		t.Fatalf("Reihenfolge: %v", got)
	}
}

func TestWallAndStation(t *testing.T) {
	e := newEnv(t)
	wf, nodes, mon := newFakeWf(), &fakeNodes{}, &fakeMon{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: mon, Poll: 1, Timeout: 1_000_000_000}
	e.m.svc.Run, e.m.rt = rt, rt
	svc := e.m.svc
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Wand", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if ev, err = svc.Transition(ctx, ev.ID, StateTesting, "alice", false); err != nil {
		t.Fatal(err)
	}
	full, _ := svc.St.GetEvent(ctx, ev.ID)
	// Bild nur für beobachtete Events: ohne Watch kein Multiviewer
	_, _ = rt.Reconcile(ctx, svc, full)
	_, _ = rt.Reconcile(ctx, svc, full)
	wall, err := rt.Wall(ctx, svc, nil)
	if err != nil || len(wall) != 1 || wall[0].PreviewNodeID != "" {
		t.Fatalf("Wand ohne Zuschauer: %+v %v", wall, err)
	}
	wall, _ = rt.Wall(ctx, svc, []string{ev.ID}) // meldet den Zuschauer
	_, _ = rt.Reconcile(ctx, svc, full)
	_, _ = rt.Reconcile(ctx, svc, full)
	wall, _ = rt.Wall(ctx, svc, []string{ev.ID})
	if len(wall) != 1 || wall[0].PreviewNodeID == "" || len(wall[0].Lines) != 1 || wall[0].Lines[0].Level == "" || wall[0].Lines[0].W == 0 {
		t.Fatalf("Wand mit Zuschauer: %+v", wall)
	}
	// Station: Abhören verbindet nur den Normalizer mit der Station, Zielnode kommt zurück
	res, err := rt.StationRoute(ctx, svc, full, full.Lines[0].ID, StationActListen)
	if err != nil || res.NodeID == "" {
		t.Fatalf("Station: %+v %v", res, err)
	}
	last := mon.links[len(mon.links)-1]
	if !strings.Contains(last, "inst-listen") {
		t.Fatalf("Abhören muss den Abhörnode treffen: %v", last)
	}
	if _, err := rt.StationRoute(ctx, svc, full, full.Lines[0].ID, StationActMeter); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mon.links[len(mon.links)-1], "inst-meter") {
		t.Fatalf("Messgerät: %v", mon.links)
	}
	if _, err := rt.StationRoute(ctx, svc, full, full.Lines[0].ID, "kaputt"); err == nil {
		t.Fatal("unbekannte Aktion muss abgelehnt werden")
	}
	// Leerlauf: Station wird abgebaut, nicht sofort
	rt.sweepStation(ctx)
	if _, ok := rt.stationWorkflow(); !ok {
		t.Fatal("frisch benutzte Station bleibt")
	}
	rt.mu.Lock()
	rt.stationUsed = time.Now().Add(-time.Hour)
	rt.mu.Unlock()
	rt.sweepStation(ctx)
	rt.sweepStation(ctx)
	if _, ok := rt.stationWorkflow(); ok {
		t.Fatal("ungenutzte Station muss verschwinden")
	}
	// Aufräumlauf darf die Station nicht als Waise des Events „station“ löschen
	if _, err := rt.StationRoute(ctx, svc, full, full.Lines[0].ID, StationActListen); err != nil {
		t.Fatal(err)
	}
	rt.sweepOrphans(ctx, svc)
	rt.sweepOrphans(ctx, svc)
	if _, ok := rt.stationWorkflow(); !ok {
		t.Fatal("sweepOrphans darf die Station nicht anfassen")
	}
}

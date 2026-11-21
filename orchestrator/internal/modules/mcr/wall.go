package mcr

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Multiview-Wand (106.13f): alle laufenden und nächsten Events mit Ampel, UMD und aktiven Prüfungen in einer Abfrage. Events mit
// Fehlern oder Alarmen stehen automatisch vorn. Die Bilder kommen von den Multiviewern der Überwachung, die nur laufen, solange
// jemand zusieht (`Watch`) — die Wand selbst kostet nur eine Statusabfrage.

// WallLine ist eine Leitung in der Wand; X/Y/W/H = ihre Fläche im Multiviewer-Bild (für Klickflächen).
type WallLine struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Level  string   `json:"level"`
	UMD    string   `json:"umd"`
	Alarms []string `json:"alarms"`
	// AlarmItems: laufende Alarme der Leitung mit Kennung (zum Quittieren).
	AlarmItems []WallAlarm `json:"alarmItems"`
	X          int         `json:"x"`
	Y          int         `json:"y"`
	W          int         `json:"w"`
	H          int         `json:"h"`
}

// WallAlarm ist ein laufender Alarm in der Wand.
type WallAlarm struct {
	ID       string    `json:"id"`
	LineID   string    `json:"lineId"`
	LineName string    `json:"lineName"`
	Kind     string    `json:"kind"`
	Severity string    `json:"severity"`
	Text     string    `json:"text"`
	Since    time.Time `json:"since"`
	AckedBy  string    `json:"ackedBy,omitempty"`
}

// WallEvent ist ein Event in der Wand.
type WallEvent struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	State         string     `json:"state"`
	PlannedStart  *time.Time `json:"plannedStart,omitempty"`
	Level         string     `json:"level"` // schlechteste Ampel seiner Leitungen; leer = keine Messdaten
	PreviewNodeID string     `json:"previewNodeId,omitempty"`
	CanvasW       int        `json:"canvasW"`
	CanvasH       int        `json:"canvasH"`
	Lines         []WallLine `json:"lines"`
	AlarmCount    int        `json:"alarmCount"`
	// Alarm-PiP (106.13e): welche Leitung gezeigt wird, ob der Operator sie festhält, Hinweise für die Bedienung.
	HasPip  bool        `json:"hasPip"`
	PipLine string      `json:"pipLine,omitempty"`
	PipLock string      `json:"pipLock,omitempty"`
	Notices []WallAlarm `json:"notices"`
	// Access: was die Person an diesem Event darf (nil = nicht angegeben).
	Access *EventAccess `json:"access,omitempty"`
}

const (
	wallPlannedWindow = 24 * time.Hour
	wallMaxPlanned    = 4
	wallMaxWatch      = 3 // Bilder kosten ~2 Kerne je Event: höchstens so viele gleichzeitig
)

func levelRank(l string) int {
	switch l {
	case AlarmBad:
		return 0
	case AlarmWarn:
		return 1
	}
	return 2
}

// SortWall ordnet die Wand: Fehler vor Warnung vor Rest, danach Sendung vor Test vor Geplant, danach nach Beginn.
func SortWall(evs []WallEvent) {
	state := map[string]int{StateLive: 0, StateTesting: 1, StatePlanned: 2}
	sort.SliceStable(evs, func(i, j int) bool {
		a, b := evs[i], evs[j]
		if levelRank(a.Level) != levelRank(b.Level) {
			return levelRank(a.Level) < levelRank(b.Level)
		}
		if state[a.State] != state[b.State] {
			return state[a.State] < state[b.State]
		}
		switch {
		case a.PlannedStart == nil && b.PlannedStart != nil:
			return false
		case a.PlannedStart != nil && b.PlannedStart == nil:
			return true
		case a.PlannedStart != nil && b.PlannedStart != nil:
			return a.PlannedStart.Before(*b.PlannedStart)
		}
		return a.Name < b.Name
	})
}

// worst: schlechteste Stufe.
func worst(levels ...string) string {
	out := ""
	for _, l := range levels {
		if l != "" && (out == "" || levelRank(l) < levelRank(out)) {
			out = l
		}
	}
	return out
}

// Wall liefert die Wand. `watch` nennt Events, deren Bild gerade angezeigt wird (Multiviewer bereithalten, höchstens drei).
func (rt *Runtime) Wall(ctx context.Context, s *Service, watch []string) ([]WallEvent, error) {
	return rt.WallFor(ctx, s, watch, nil, nil)
}

// WallFor wie Wall, zeigt aber nur Events, die `visible` zulässt (nil = alle).
func (rt *Runtime) WallFor(ctx context.Context, s *Service, watch []string, visible func(Event) bool, access func(Event) *EventAccess) ([]WallEvent, error) {
	var evs []Event
	for _, st := range []string{StateLive, StateTesting, StatePlanned} {
		list, err := s.St.ListEvents(ctx, st)
		if err != nil {
			return nil, err
		}
		if st == StatePlanned {
			var soon []Event
			for _, e := range list {
				if e.PlannedStart != nil && time.Until(*e.PlannedStart) < wallPlannedWindow && e.PlannedStart.After(time.Now().Add(-wallPlannedWindow)) {
					soon = append(soon, e)
				}
			}
			if len(soon) > wallMaxPlanned {
				soon = soon[:wallMaxPlanned]
			}
			list = soon
		}
		evs = append(evs, list...)
	}
	allow := map[string]bool{}
	for i, id := range watch {
		if i < wallMaxWatch {
			allow[id] = true
		}
	}
	out := make([]WallEvent, 0, len(evs))
	for _, e0 := range evs {
		e, err := s.St.GetEvent(ctx, e0.ID)
		if err != nil || (visible != nil && !visible(e)) {
			continue
		}
		we := WallEvent{ID: e.ID, Name: e.Name, State: e.State, PlannedStart: e.PlannedStart, Lines: []WallLine{}, Notices: []WallAlarm{}}
		if access != nil {
			we.Access = access(e)
		}
		live := e.State == StateTesting || e.State == StateLive
		var open []Alarm
		mon, _ := ParseMon(e.Monitoring)
		if live {
			open, _ = s.St.EventAlarms(ctx, e.ID, true)
			we.HasPip = HasPip(mon.Reactions)
			rt.mu.Lock()
			we.PipLine, we.PipLock = rt.pip[e.ID].Current, rt.pip[e.ID].Lock
			rt.mu.Unlock()
		}
		if live && allow[e.ID] {
			rt.Watch(e.ID)
		}
		var layout *MVLayout
		var alarms map[string][]string
		rt.mu.Lock()
		if l, ok := rt.monLast[e.ID]; ok {
			layout = &l
		}
		alarms = rt.monAlarms[e.ID]
		rt.mu.Unlock()
		pips := map[string]MVPip{}
		if layout != nil {
			we.CanvasW, we.CanvasH = layout.CanvasWidth, layout.CanvasHeight
			for _, p := range layout.Pips {
				pips[p.ID] = p
			}
		}
		for _, l := range e.Lines {
			wl := WallLine{ID: l.ID, Name: l.Name, Alarms: []string{}, AlarmItems: []WallAlarm{}}
			for _, a := range open {
				if a.LineID != l.ID {
					continue
				}
				wa := WallAlarm{ID: a.ID, LineID: a.LineID, LineName: a.LineName, Kind: a.Kind, Severity: a.Severity, Text: a.Text, Since: a.StartedAt, AckedBy: a.AckedBy}
				wl.AlarmItems = append(wl.AlarmItems, wa)
				for _, act := range ActionsFor(mon.Reactions, a) {
					if act == ActNotice {
						we.Notices = append(we.Notices, wa)
					}
				}
			}
			if p, ok := pips[l.ID]; ok {
				wl.Level, wl.UMD, wl.X, wl.Y, wl.W, wl.H = p.Alarm, p.UMD, p.X, p.Y, p.Width, p.Height
			}
			if a := alarms[l.ID]; len(a) > 0 {
				wl.Alarms = a
				we.AlarmCount += len(a)
			}
			we.Level = worst(we.Level, wl.Level)
			we.Lines = append(we.Lines, wl)
		}
		if live && rt.Monitor != nil {
			if have, err := rt.monWorkflows(e.ID); err == nil {
				if mv, ok := have[""]; ok {
					if inst := instanceOf(mv, monRoleMV); inst != "" {
						we.PreviewNodeID, _ = rt.Monitor.NodeID(inst)
					}
				}
			}
		}
		out = append(out, we)
	}
	SortWall(out)
	return out, nil
}

// ---- Abhör-/Messstation ----

// Die Station ist ein eigener kleiner Workflow mit einem Abhörnode und einem Scope im Vollmodus. Sie entsteht beim ersten Gebrauch
// und wird nach `stationIdle` ohne Nutzung vom Aufräumlauf entfernt.
const (
	stationName      = "mcr-mon-station"
	stationIdle      = 15 * time.Minute
	stationWait      = 40 * time.Second
	NodeAudioMon     = "omp-audio-monitor"
	stationListen    = "listen"
	stationMeter     = "meter"
	StationActListen = "listen"
	StationActMeter  = "meter"
)

var stationDesc = monDesc("station", "")

// StationResult beschreibt, wohin die Leitung geroutet wurde.
type StationResult struct {
	Action string `json:"action"`
	NodeID string `json:"nodeId"`
	Label  string `json:"label"`
}

func stationDefinition() workflows.Definition {
	return workflows.Definition{Title: "MCR Abhör- und Messstation", Category: "mcr", Tags: []string{"mcr", "mcr-mon"}, Description: stationDesc,
		Roles: []workflows.Role{{Name: stationListen, NodeType: NodeAudioMon}, {Name: stationMeter, NodeType: NodeScope}}}
}

func (rt *Runtime) stationWorkflow() (workflows.Workflow, bool) {
	all, err := rt.Wf.List()
	if err != nil {
		return workflows.Workflow{}, false
	}
	for _, w := range all {
		if w.Definition.Description == stationDesc {
			return w, true
		}
	}
	return workflows.Workflow{}, false
}

// StationRoute führt Ton (Abhören) bzw. Bild und Ton (Messgerät) der Leitung auf die Station.
func (rt *Runtime) StationRoute(ctx context.Context, s *Service, e Event, lineID, action string) (StationResult, error) {
	role := stationListen
	switch action {
	case StationActListen:
	case StationActMeter:
		role = stationMeter
	default:
		return StationResult{}, fmt.Errorf("%w: Aktion %q unbekannt", ErrValidation, action)
	}
	if rt.Monitor == nil {
		return StationResult{}, errors.New("Überwachung nicht verfügbar")
	}
	outV, outA, err := rt.LineOutputs(s, e, lineID)
	if err != nil {
		return StationResult{}, err
	}
	if outV == "" && outA == "" {
		return StationResult{}, errors.New("die Leitung läuft nicht")
	}
	wf, ok := rt.stationWorkflow()
	if !ok {
		if wf, err = rt.Wf.Create(stationName, stationDefinition(), nil, ""); err != nil {
			return StationResult{}, fmt.Errorf("Station anlegen: %w", err)
		}
	}
	rt.mu.Lock()
	rt.stationUsed = time.Now()
	rt.mu.Unlock()
	if wf.Status == workflows.StatusStopped || wf.Status == "" {
		if err := rt.Wf.Start(ctx, wf.ID); err != nil {
			return StationResult{}, fmt.Errorf("Station starten: %w", err)
		}
	}
	deadline := time.Now().Add(stationWait)
	var inst, nodeID string
	for {
		cur, err := rt.Wf.Get(wf.ID)
		if err != nil {
			return StationResult{}, err
		}
		if inst = instanceOf(cur, role); inst != "" {
			if _, ok := rt.Nodes.BaseURL(inst); ok {
				if nodeID, ok = rt.Monitor.NodeID(inst); ok {
					break
				}
			}
		}
		if time.Now().After(deadline) {
			return StationResult{}, errors.New("die Station ist noch nicht bereit, bitte gleich noch einmal versuchen")
		}
		select {
		case <-ctx.Done():
			return StationResult{}, ctx.Err()
		case <-time.After(rt.poll()):
		}
	}
	if err := rt.Monitor.LinkInstances(ctx, outV, outA, inst); err != nil {
		return StationResult{}, err
	}
	return StationResult{Action: action, NodeID: nodeID, Label: strings.TrimSpace(role)}, nil
}

// sweepStation entfernt die Station nach langer Nichtbenutzung (zweistufig wie die übrigen Reste).
func (rt *Runtime) sweepStation(ctx context.Context) {
	w, ok := rt.stationWorkflow()
	if !ok {
		return
	}
	rt.mu.Lock()
	idle := time.Since(rt.stationUsed) > stationIdle
	rt.mu.Unlock()
	if !idle {
		return
	}
	if w.Status == workflows.StatusStopped || w.Status == "" {
		_ = rt.Wf.Delete(w.ID)
		return
	}
	_ = rt.Wf.Stop(ctx, w.ID, true)
}

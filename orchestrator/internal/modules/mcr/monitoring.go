package mcr

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Dynamisches Event-Monitoring (106.13). Entscheidung: Der Workflow-Dienst kann Rollen eines laufenden Workflows nicht ergänzen
// oder entfernen (`Update` lässt die Prozesse unberührt). Darum gibt es je Event einen kleinen Multiviewer-Workflow und je Leitung
// einen eigenen Scope-Workflow; sie entstehen und verschwinden einzeln, ohne die übrigen Leitungen zu unterbrechen.
// Verbunden werden sie über die Instanzen (IS-05), wie bei vorhandenen Quellen.

const (
	// MonPrefix steht in der Beschreibung der Überwachungs-Workflows: „mcr-mon:<Event>“ bzw. „mcr-mon:<Event>/<Leitung>“.
	MonPrefix = "mcr-mon:"

	NodeScope       = "omp-scope"
	NodeMultiviewer = "omp-multiviewer-custom"

	monRoleScope = "scope"
	monRoleMV    = "mv"

	// monMinInterval: UMD und Ampel höchstens alle 2 s senden.
	monMinInterval = 2 * time.Second
)

// MonitorFabric verbindet und findet Sender der Überwachungs-Instanzen.
type MonitorFabric interface {
	// VideoSender: Bild-Sender einer Instanz (Normalizer-Ausgang).
	VideoSender(instanceID string) (string, bool)
	// NodeID: IS-04-Node-ID einer Instanz (für Vorschau und Bedienoberfläche).
	NodeID(instanceID string) (string, bool)
	// LinkInstances verbindet Bild- und Tonsender der ersten mit den Empfängern der zweiten Instanz.
	LinkInstances(ctx context.Context, fromVideo, fromAudio, toInstance string) error
}

func monDesc(eventID, lineID string) string {
	if lineID == "" {
		return MonPrefix + eventID
	}
	return MonPrefix + eventID + "/" + lineID
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// monName: stabiler Workflow-Name je Event bzw. Leitung.
func monName(e Event, lineID string) string {
	if lineID == "" {
		return "mcr-mon-" + short(e.ID)
	}
	return "mcr-mon-" + short(e.ID) + "-" + short(lineID)
}

// MonitoringPlan nennt, welche Überwachungs-Workflows ein Event braucht: Multiviewer immer (bei mindestens einer Leitung),
// Scope je Leitung. `have` sind die vorhandenen (Schlüssel: Leitungs-ID, "" = Multiviewer).
type MonitoringPlan struct {
	Create []string // Schlüssel, die fehlen
	Remove []string // Schlüssel, die nicht mehr gebraucht werden
}

// PlanMonitoring ist rein: aus den Leitungs-IDs und den vorhandenen Workflows entsteht der Plan. Der Multiviewer (teuer, ~2 Kerne)
// läuft nur, solange ihn jemand ansieht (`withMV`); die Scopes laufen immer, sie erkennen die Alarme.
func PlanMonitoring(lineIDs []string, have map[string]bool, withMV bool) MonitoringPlan {
	want := map[string]bool{}
	if len(lineIDs) > 0 && withMV {
		want[""] = true
	}
	for _, id := range lineIDs {
		want[id] = true
	}
	var p MonitoringPlan
	for k := range want {
		if !have[k] {
			p.Create = append(p.Create, k)
		}
	}
	for k := range have {
		if !want[k] {
			p.Remove = append(p.Remove, k)
		}
	}
	sortStrings(p.Create)
	sortStrings(p.Remove)
	return p
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// monDefinition: eine Rolle je Überwachungs-Workflow.
func monDefinition(e Event, lineID string) workflows.Definition {
	d := workflows.Definition{Category: "mcr", Tags: []string{"mcr", "mcr-mon"}, Description: monDesc(e.ID, lineID)}
	if lineID == "" {
		d.Title = "MCR Multiviewer · " + e.Name
		d.Roles = []workflows.Role{{Name: monRoleMV, NodeType: NodeMultiviewer}}
		if mon, _ := ParseMon(e.Monitoring); HasPip(mon.Reactions) {
			d.Roles = append(d.Roles, workflows.Role{Name: monRoleAlarm, NodeType: NodeSwitcher}) // Alarm-PiP (106.13e)
		}
		return d
	}
	name := lineID
	for _, l := range e.Lines {
		if l.ID == lineID {
			name = l.Name
		}
	}
	d.Title = "MCR Überwachung · " + e.Name + " · " + name
	d.Roles = []workflows.Role{{Name: monRoleScope, NodeType: NodeScope}}
	return d
}

// MonitorEnv: Startumgebung der Überwachungs-Rollen (Scope ohne Waveform-/Vektorskop-Bild, spart CPU).
func MonitorEnv(def workflows.Definition, role workflows.Role) map[string]string {
	if !strings.HasPrefix(def.Description, MonPrefix) || def.Description == stationDesc || role.NodeType != NodeScope {
		return nil
	}
	return map[string]string{"OMP_SCOPE_MODE": "monitor"}
}

// monWorkflows liefert die vorhandenen Überwachungs-Workflows eines Events nach Leitungs-ID ("" = Multiviewer).
func (rt *Runtime) monWorkflows(eventID string) (map[string]workflows.Workflow, error) {
	all, err := rt.Wf.List()
	if err != nil {
		return nil, err
	}
	out := map[string]workflows.Workflow{}
	base := monDesc(eventID, "")
	for _, w := range all {
		d := w.Definition.Description
		switch {
		case d == base:
			out[""] = w
		case strings.HasPrefix(d, base+"/"):
			out[strings.TrimPrefix(d, base+"/")] = w
		}
	}
	return out, nil
}

// StopMonitoring beendet und entfernt alle Überwachungs-Workflows eines Events (Abbau, Abbruch, Löschen).
func (rt *Runtime) StopMonitoring(ctx context.Context, eventID string) {
	if rt.Monitor == nil {
		return
	}
	have, err := rt.monWorkflows(eventID)
	if err != nil {
		return
	}
	for k, w := range have {
		if err := rt.DeleteWorkflow(ctx, w.ID); err != nil {
			slog.Warn("mcr: Überwachung entfernen", "event", eventID, "line", k, "error", err)
		}
	}
	rt.mu.Lock()
	for k := range rt.monLinked {
		if strings.HasPrefix(k, eventID+"/") {
			delete(rt.monLinked, k)
		}
	}
	delete(rt.monSent, eventID)
	delete(rt.monLast, eventID)
	delete(rt.monAlarms, eventID)
	rt.mu.Unlock()
}

// reconcileMonitoring führt die Überwachung eines laufenden Events nach: fehlende Workflows anlegen und starten, überzählige
// entfernen, Normalizer → Scope verbinden, Multiviewer-Zustand senden. Fehler in einer Leitung stören die anderen nicht.
func (rt *Runtime) reconcileMonitoring(ctx context.Context, s *Service, e Event, wf workflows.Workflow, roles map[string]LineRoles) {
	if rt.Monitor == nil {
		return
	}
	have, err := rt.monWorkflows(e.ID)
	if err != nil {
		slog.Warn("mcr: Überwachung: Workflows nicht lesbar", "event", e.ID, "error", err)
		return
	}
	var ids []string
	for _, l := range e.Lines {
		if _, ok := roles[l.ID]; ok {
			ids = append(ids, l.ID)
		}
	}
	present := map[string]bool{}
	for k := range have {
		present[k] = true
	}
	plan := PlanMonitoring(ids, present, rt.watched(e.ID))
	for _, k := range plan.Remove {
		if err := rt.DeleteWorkflow(ctx, have[k].ID); err != nil {
			slog.Warn("mcr: Überwachung entfernen", "event", e.ID, "line", k, "error", err)
		}
		delete(have, k)
		rt.mu.Lock()
		delete(rt.monLinked, e.ID+"/"+k)
		rt.mu.Unlock()
	}
	// Reaktionsregeln mit/ohne Alarm-PiP geändert: den Multiviewer-Workflow umformen (Switcher kommt/geht), ohne ihn zu stoppen.
	if w, ok := have[""]; ok {
		if want := monDefinition(e, ""); topologyDiffers(w.Definition, want) {
			var err error
			if w.Status == workflows.StatusStarted {
				err = rt.Wf.Reshape(ctx, w.ID, w.Name, want)
			} else {
				_, err = rt.Wf.Update(w.ID, w.Name, want)
			}
			if err != nil {
				slog.Warn("mcr: Alarm-PiP-Rolle", "event", e.ID, "error", err)
			}
		}
	}
	for _, k := range plan.Create {
		w, err := rt.Wf.Create(monName(e, k), monDefinition(e, k), nil, "")
		if err != nil {
			slog.Warn("mcr: Überwachung anlegen", "event", e.ID, "line", k, "error", err)
			continue
		}
		have[k] = w
	}
	for k, w := range have {
		if w.Status == workflows.StatusStopped || w.Status == "" {
			if err := rt.Wf.Start(ctx, w.ID); err != nil {
				slog.Warn("mcr: Überwachung starten", "event", e.ID, "line", k, "error", err)
			}
		}
	}

	var tiles []Tile
	alarms := map[string][]string{}
	outSender := map[string]string{}
	for _, id := range ids {
		var line Line
		for _, l := range e.Lines {
			if l.ID == id {
				line = l
			}
		}
		lr := roles[id]
		normInst := instanceOf(wf, lr.Normalizer)
		outV, outA := instanceOf(wf, lr.VideoOut()), instanceOf(wf, lr.AudioOut())
		if normInst == "" {
			tiles = append(tiles, Tile{ID: id, UMD: line.Name, Alarm: AlarmWarn})
			continue
		}
		sender, _ := rt.Monitor.VideoSender(outV)
		outSender[id] = sender
		norm, _ := rt.readParams(ctx, normInst, []string{"normalize.state", "normalize.inputFormat", "avsync.appliedMs"})
		var active []string
		if sw, ok := have[id]; ok {
			if scopeInst := instanceOf(sw, monRoleScope); scopeInst != "" {
				rt.linkScope(ctx, e, line, outV, outA, scopeInst)
				rt.applyScopeProfile(ctx, e, line, scopeInst)
				active = rt.activeAlarms(ctx, scopeInst)
			}
		}
		alarms[id] = active
		tiles = append(tiles, Tile{ID: id, SenderID: sender, UMD: UMDText(line.Name, norm), Alarm: AlarmLevel(norm, len(active))})
	}
	if mw, ok := have[""]; ok && HasPip(mustMon(e).Reactions) {
		swInst := instanceOf(mw, monRoleAlarm)
		shown := rt.reconcilePip(ctx, s, e, outSender, swInst)
		pipSender := ""
		if swInst != "" {
			pipSender, _ = rt.Monitor.VideoSender(swInst)
		}
		level := AlarmNone
		if shown != "" {
			level = AlarmWarn
		}
		tiles = append(tiles, Tile{ID: pipTileID, SenderID: pipSender, UMD: "ALARM-PIP", Alarm: level})
	}
	rt.mu.Lock()
	if rt.monAlarms == nil {
		rt.monAlarms = map[string]map[string][]string{}
	}
	rt.monAlarms[e.ID] = alarms
	if len(tiles) > 0 { // Ampel/UMD für die Wand, auch wenn kein Multiviewer läuft
		if rt.monLast == nil {
			rt.monLast = map[string]MVLayout{}
		}
		rt.monLast[e.ID] = BuildLayout(tiles)
	}
	rt.mu.Unlock()
	if mw, ok := have[""]; ok && len(tiles) > 0 {
		if inst := instanceOf(mw, monRoleMV); inst != "" {
			rt.sendLayout(ctx, e.ID, inst, BuildLayout(tiles))
		}
	}
}

// linkScope verbindet den Normalizer einer Leitung mit ihrem Scope und setzt den Leitungsnamen; je Instanzpaar nur einmal.
func (rt *Runtime) linkScope(ctx context.Context, e Event, l Line, outV, outA, scopeInst string) {
	key := e.ID + "/" + l.ID
	sig := outV + "|" + outA + "|" + scopeInst + "|" + l.Name
	rt.mu.Lock()
	same := rt.monLinked[key] == sig
	rt.mu.Unlock()
	if same {
		return
	}
	base, ok := rt.Nodes.BaseURL(scopeInst)
	if !ok {
		return // Scope noch nicht in der Registry: nächster Abgleich
	}
	if err := rt.Monitor.LinkInstances(ctx, outV, outA, scopeInst); err != nil {
		slog.Warn("mcr: Überwachung verbinden", "event", e.ID, "line", l.Name, "error", err)
		return
	}
	if err := rt.patch(ctx, base, "qc.line", l.Name); err != nil {
		slog.Warn("mcr: Überwachung: Leitungsname", "event", e.ID, "line", l.Name, "error", err)
	}
	rt.mu.Lock()
	if rt.monLinked == nil {
		rt.monLinked = map[string]string{}
	}
	rt.monLinked[key] = sig
	rt.mu.Unlock()
}

// activeAlarms nennt die aktiven Prüfungen (`qc.status`) eines Scopes.
func (rt *Runtime) activeAlarms(ctx context.Context, scopeInst string) []string {
	p, err := rt.readParams(ctx, scopeInst, []string{"qc.status"})
	if err != nil {
		return nil
	}
	s, _ := p["qc.status"].(string)
	var st []struct {
		Check   string `json:"check"`
		Active  bool   `json:"active"`
		Enabled bool   `json:"enabled"`
	}
	if json.Unmarshal([]byte(s), &st) != nil {
		return nil
	}
	var out []string
	for _, c := range st {
		if c.Active && c.Enabled {
			out = append(out, c.Check)
		}
	}
	return out
}

// sendLayout sendet den Multiviewer-Zustand nur bei Änderung und höchstens alle 2 s; ein neu gestarteter Multiviewer bekommt ihn erneut.
func (rt *Runtime) sendLayout(ctx context.Context, eventID, inst string, l MVLayout) {
	b, _ := json.Marshal(l)
	sig := inst + "|" + string(b)
	rt.mu.Lock()
	last := rt.monSent[eventID]
	rt.mu.Unlock()
	if last.sig == sig || time.Since(last.at) < monMinInterval {
		return
	}
	base, ok := rt.Nodes.BaseURL(inst)
	if !ok {
		return
	}
	rt.mu.Lock() // auch ein Fehlversuch zählt für die Drosselung (kein Dauerfeuer)
	if rt.monSent == nil {
		rt.monSent = map[string]monSent{}
	}
	rt.monSent[eventID] = monSent{sig: last.sig, at: time.Now(), layout: last.layout}
	rt.mu.Unlock()
	body, code, err := rt.Nodes.Do(ctx, http.MethodPost, base+"/state", map[string]any{"state": l})
	if err != nil || code >= 300 {
		slog.Warn("mcr: Multiviewer-Zustand", "event", eventID, "error", err, "status", code, "body", strings.TrimSpace(string(body)))
		return
	}
	rt.mu.Lock()
	if rt.monSent == nil {
		rt.monSent = map[string]monSent{}
	}
	rt.monSent[eventID] = monSent{sig: sig, at: time.Now(), layout: &l}
	rt.mu.Unlock()
}

type monSent struct {
	sig    string
	at     time.Time
	layout *MVLayout // zuletzt erfolgreich gesendeter Zustand
}

// MonitoringStatus: Überwachung eines Events für die Statusabfrage (Multiviewer-Zustand, Zahl der Scopes).
func (rt *Runtime) MonitoringStatus(eventID string) map[string]any {
	have, err := rt.monWorkflows(eventID)
	if err != nil || len(have) == 0 {
		return map[string]any{"active": false, "scopes": 0}
	}
	scopes := 0
	for k := range have {
		if k != "" {
			scopes++
		}
	}
	out := map[string]any{"active": true, "scopes": scopes}
	rt.mu.Lock()
	if l, ok := rt.monLast[eventID]; ok {
		out["layout"] = l
	}
	out["alarms"] = rt.monAlarms[eventID]
	rt.mu.Unlock()
	return out
}

// sweepOrphans räumt auf, was ein Event nicht mehr braucht: Überwachungs-Workflows eines Events, das nicht mehr in Test oder auf
// Sendung ist (oder nicht mehr existiert), und Event-Workflows gelöschter Events. Läuft ohne Warten in zwei Schritten über die
// Abgleichschleife (erst anhalten, beim nächsten Durchlauf löschen) — so bleibt kein Prozess dauerhaft zurück und nichts brennt CPU.
func (rt *Runtime) sweepOrphans(ctx context.Context, s *Service) {
	all, err := rt.Wf.List()
	if err != nil {
		return
	}
	for _, w := range all {
		d := w.Definition.Description
		var eventID string
		mon := false
		switch {
		case d == stationDesc:
			continue // Abhör-/Messstation: eigener Leerlauf-Abbau (`sweepStation`)
		case strings.HasPrefix(d, MonPrefix):
			mon = true
			eventID, _, _ = strings.Cut(strings.TrimPrefix(d, MonPrefix), "/")
		case strings.HasPrefix(d, DescriptionPrefix):
			eventID = strings.TrimPrefix(d, DescriptionPrefix)
		default:
			continue
		}
		e, err := s.St.GetEvent(ctx, eventID)
		gone := errors.Is(err, ErrNotFound)
		if err != nil && !gone {
			continue
		}
		if !(gone || (mon && e.State != StateTesting && e.State != StateLive)) {
			continue
		}
		switch w.Status {
		case workflows.StatusStopped, "":
			if err := rt.Wf.Delete(w.ID); err != nil && !errors.Is(err, workflows.ErrNotFound) {
				slog.Warn("mcr: Aufräumen: Workflow löschen", "workflow", w.ID, "error", err)
			}
		default:
			if err := rt.Wf.Stop(ctx, w.ID, true); err != nil && !errors.Is(err, workflows.ErrNotRunning) {
				slog.Warn("mcr: Aufräumen: Workflow stoppen", "workflow", w.ID, "error", err)
			}
		}
	}
}

// watchTTL: so lange nach der letzten Abfrage gilt ein Event als „angesehen“.
const watchTTL = 45 * time.Second

// Watch meldet, dass jemand die Überwachung des Events ansieht (Statusabfrage der Oberfläche); der Multiviewer wird dann gestartet.
func (rt *Runtime) Watch(eventID string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.watch == nil {
		rt.watch = map[string]time.Time{}
	}
	rt.watch[eventID] = time.Now()
}

func (rt *Runtime) watched(eventID string) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return time.Since(rt.watch[eventID]) < watchTTL
}

// applyScopeProfile sendet Profil und Abweichungen der Leitung an ihren Scope (Quelle der Wahrheit = Datenbank); je Instanz und Stand einmal,
// nach Neustart der Instanz und bei Änderung erneut — zur Laufzeit ohne Neustart.
func (rt *Runtime) applyScopeProfile(ctx context.Context, e Event, l Line, scopeInst string) {
	params := EffectiveMon(e.Monitoring, l.Monitoring).ScopeParams()
	if len(params) == 0 {
		return
	}
	b, _ := json.Marshal(params)
	sig := scopeInst + "|" + string(b)
	key := e.ID + "/mon-" + l.ID
	rt.mu.Lock()
	same := rt.applied[key] == sig
	rt.mu.Unlock()
	if same {
		return
	}
	base, ok := rt.Nodes.BaseURL(scopeInst)
	if !ok {
		return
	}
	for _, p := range params {
		if err := rt.patch(ctx, base, p.Name, p.Value); err != nil {
			slog.Warn("mcr: Überwachungsprofil", "event", e.ID, "line", l.Name, "param", p.Name, "error", err)
			return
		}
	}
	rt.mu.Lock()
	if rt.applied == nil {
		rt.applied = map[string]string{}
	}
	rt.applied[key] = sig
	rt.mu.Unlock()
}

func mustMon(e Event) MonCfg {
	c, _ := ParseMon(e.Monitoring)
	return c
}

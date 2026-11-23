package mcr

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// SettingHouseFormat: Schlüssel der Moduleinstellung mit dem Hausformat der Vorgabe (kein fester Wert im Code).
const SettingHouseFormat = "mcr.houseFormat"

type Service struct {
	St       *Store
	Settings module.NodeSettings
	Audit    module.DomainAudit
	// Run: Anbindung an Workflow-Dienst und Nodes (106.10). nil = nur Datenbank (Zustandswechsel ohne Wirkung auf Nodes).
	Run *Runtime
}

func (s *Service) audit(actor, object, action string, d map[string]any) {
	if s.Audit != nil {
		s.Audit.Log(actor, "mcr", object, action, d)
	}
}

// GlobalHouse liest das Hausformat der Vorgabe (nil = nicht gesetzt).
func (s *Service) GlobalHouse() (*HouseFormat, error) {
	if s.Settings == nil {
		return nil, nil
	}
	b, err := s.Settings.Get(SettingHouseFormat)
	if errors.Is(err, module.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseHouse(b)
}

func (s *Service) SetGlobalHouse(raw json.RawMessage) error {
	h, err := ParseHouse(raw)
	if err != nil {
		return bad("%v", err)
	}
	b, _ := json.Marshal(h)
	if h == nil {
		b = []byte("{}")
	}
	return s.Settings.Put(SettingHouseFormat, b)
}

// withEffective ergänzt das wirksame Hausformat je Leitung (Vorgabe → Event → Leitung).
func (s *Service) withEffective(e *Event) error {
	g, err := s.GlobalHouse()
	if err != nil {
		return err
	}
	ev, _ := ParseHouse(e.HouseFormat)
	e.Effective = map[string]HouseFormat{}
	for _, l := range e.Lines {
		lh, _ := ParseHouse(l.HouseFormat)
		e.Effective[l.ID] = Effective(g, ev, lh)
	}
	return nil
}

func (s *Service) validateEvent(e *Event) error {
	if strings.TrimSpace(e.Name) == "" {
		return bad("Event ohne Namen")
	}
	if e.PlannedStart != nil && e.PlannedEnd != nil && e.PlannedEnd.Before(*e.PlannedStart) {
		return bad("Ende liegt vor dem Beginn")
	}
	if _, err := ParseHouse(e.HouseFormat); err != nil {
		return bad("%v", err)
	}
	if err := checkNoSecrets("houseFormat", e.HouseFormat); err != nil {
		return err
	}
	cc := s.ChainConfig()
	if err := ValidateChain("Event", e.Chain, cc); err != nil {
		return err
	}
	if err := ValidateMon("Event", e.Monitoring, true); err != nil {
		return err
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	for i := range e.Lines {
		l := &e.Lines[i]
		if l.ID == "" {
			l.ID = newID()
		}
		if ids[l.ID] {
			return bad("Leitungs-ID „%s“ doppelt", l.ID)
		}
		ids[l.ID] = true
		if err := validateLine(l); err != nil {
			return err
		}
		if err := ValidateChain("Leitung „"+l.Name+"“", l.Chain, cc); err != nil {
			return err
		}
		if err := ValidateMon("Leitung „"+l.Name+"“", l.Monitoring, false); err != nil {
			return err
		}
		if err := ValidateRecord("Leitung „"+l.Name+"“", l.Record); err != nil {
			return err
		}
		if names[l.Name] {
			return bad("Leitungsname „%s“ doppelt", l.Name)
		}
		names[l.Name] = true
	}
	return validateMembers(e.Members)
}

func (s *Service) ValidateTemplate(t *Template) error {
	if strings.TrimSpace(t.Name) == "" {
		return bad("Vorlage ohne Namen")
	}
	if _, err := ParseHouse(t.HouseFormat); err != nil {
		return bad("%v", err)
	}
	names := map[string]bool{}
	for i := range t.Lines {
		l := &t.Lines[i]
		if l.ID == "" {
			l.ID = newID()
		}
		if err := validateLine(l); err != nil {
			return err
		}
		if names[l.Name] {
			return bad("Leitungsname „%s“ doppelt", l.Name)
		}
		names[l.Name] = true
	}
	return nil
}

// NewEventInput: Eingabe zum Anlegen. Mit `TemplateID` werden die Leitungen (neue IDs) und das Hausformat der Vorlage übernommen,
// sofern nicht ausdrücklich eigene angegeben sind.
type NewEventInput struct {
	Name         string          `json:"name"`
	TemplateID   string          `json:"templateId"`
	PlannedStart *time.Time      `json:"plannedStart"`
	PlannedEnd   *time.Time      `json:"plannedEnd"`
	Owner        string          `json:"owner"`
	OwnerGroup   string          `json:"ownerGroup"`
	HouseFormat  json.RawMessage `json:"houseFormat"`
	Chain        json.RawMessage `json:"chain"`
	Monitoring   json.RawMessage `json:"monitoring"`
	Lines        []Line          `json:"lines"`
	Members      []Member        `json:"members"`
}

func (s *Service) CreateEvent(ctx context.Context, in NewEventInput, actor string) (Event, error) {
	e := Event{Name: in.Name, TemplateID: in.TemplateID, PlannedStart: in.PlannedStart, PlannedEnd: in.PlannedEnd, Owner: in.Owner, OwnerGroup: in.OwnerGroup,
		HouseFormat: in.HouseFormat, Chain: in.Chain, Monitoring: in.Monitoring, Lines: in.Lines, Members: in.Members}
	if e.Owner == "" && e.OwnerGroup == "" {
		e.Owner = actor
	}
	if in.TemplateID != "" {
		t, err := s.St.GetTemplate(ctx, in.TemplateID)
		if err != nil {
			return e, err
		}
		if len(e.Lines) == 0 {
			for _, l := range t.Lines {
				l.ID = "" // neue IDs je Event
				e.Lines = append(e.Lines, l)
			}
		}
		if len(e.HouseFormat) == 0 {
			e.HouseFormat = t.HouseFormat
		}
	}
	if err := s.validateEvent(&e); err != nil {
		return e, err
	}
	out, err := s.St.CreateEvent(ctx, e, actor)
	if err != nil {
		return out, err
	}
	s.audit(actor, out.ID, "event.create", map[string]any{"name": out.Name, "templateId": out.TemplateID, "lines": len(out.Lines)})
	return out, s.withEffective(&out)
}

func (s *Service) GetEvent(ctx context.Context, id string) (Event, error) {
	e, err := s.St.GetEvent(ctx, id)
	if err != nil {
		return e, err
	}
	return e, s.withEffective(&e)
}

// UpdateEvent: in `teardown`, `done`, `cancelled` ändert sich nichts. In `live` darf sich die Leitungsstruktur nicht ändern
// (gleiche IDs, Namen und Arten), nur Einstellungen — Änderungen am Ausgleich gehen später als Rampe an die Nodes (106.10).
func (s *Service) UpdateEvent(ctx context.Context, id string, in NewEventInput, replaceLines bool, actor string) (Event, error) {
	cur, err := s.St.GetEvent(ctx, id)
	if err != nil {
		return cur, err
	}
	if !editable(cur.State) {
		return cur, ErrState
	}
	e := cur
	e.Name, e.PlannedStart, e.PlannedEnd, e.Owner, e.OwnerGroup, e.HouseFormat = in.Name, in.PlannedStart, in.PlannedEnd, in.Owner, in.OwnerGroup, in.HouseFormat
	e.Chain = in.Chain
	e.Monitoring = in.Monitoring
	if replaceLines {
		e.Lines = in.Lines
	}
	if err := s.validateEvent(&e); err != nil {
		return e, err
	}
	if cur.State == StateLive {
		if replaceLines && !sameStructure(cur.Lines, e.Lines) {
			return e, ErrState
		}
		// Eine Kettenänderung formt den Workflow um: auf Sendung nicht erlaubt.
		if !sameJSON(cur.Chain, e.Chain) {
			return e, ErrState
		}
		if replaceLines {
			old := map[string]json.RawMessage{}
			for _, l := range cur.Lines {
				old[l.ID] = l.Chain
			}
			for _, l := range e.Lines {
				if !sameJSON(old[l.ID], l.Chain) {
					return e, ErrState
				}
			}
		}
	}
	out, err := s.St.UpdateEvent(ctx, e, replaceLines)
	if err != nil {
		return out, err
	}
	s.audit(actor, id, "event.update", map[string]any{"state": out.State})
	if s.Run != nil && (out.State == StateTesting || out.State == StateLive) {
		if err := s.Run.Refresh(ctx, s, out); err != nil {
			return out, err
		}
	}
	return out, s.withEffective(&out)
}

func sameStructure(a, b []Line) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]Line{}
	for _, l := range a {
		m[l.ID] = l
	}
	for _, l := range b {
		o, ok := m[l.ID]
		if !ok || o.Name != l.Name || o.Kind != l.Kind {
			return false
		}
	}
	return true
}

// Transition wechselt den Zustand; ungültige Übergänge → ErrState (409). Mit Laufzeit hat der Wechsel Wirkung auf den Workflow:
//
//	planned → testing    Workflow anlegen/aktualisieren und starten
//	testing → planned    Workflow stoppen (bleibt für den nächsten Versuch erhalten)
//	testing → live       Stoppbestätigung des Workflows einschalten
//	live → teardown      Workflow **bestätigt** stoppen (`confirm` nötig, sonst ErrConfirm)
//	teardown → done      Workflow löschen, Ressourcen freigeben
//	* → cancelled        Workflow stoppen und löschen
//
// Scheitert die Wirkung, bleibt der Zustand unverändert.
func (s *Service) Transition(ctx context.Context, id, to, actor string, confirm bool) (Event, error) {
	cur, err := s.St.GetEvent(ctx, id)
	if err != nil {
		return cur, err
	}
	if err := lifecycle.Validate(cur.State, to); err != nil {
		if errors.Is(err, statemachine.ErrInvalidTransition) {
			return cur, ErrState
		}
		return cur, err
	}
	if rt := s.Run; rt != nil {
		if err := s.effect(ctx, rt, cur, to, confirm); err != nil {
			return cur, err
		}
	}
	if err := s.St.SetState(ctx, id, cur.State, to); err != nil {
		return cur, err
	}
	s.audit(actor, id, "event.transition", map[string]any{"from": cur.State, "to": to})
	return s.GetEvent(ctx, id)
}

func (s *Service) effect(ctx context.Context, rt *Runtime, cur Event, to string, confirm bool) error {
	next := cur
	next.State = to
	if to != StateTesting && to != StateLive {
		rt.StopMonitoring(ctx, cur.ID) // Abbau, Rücknahme, Abbruch: keine Überwachung ohne Event
		_, _ = s.St.CloseEventAlarms(ctx, cur.ID)
		rt.mu.Lock()
		delete(rt.pip, cur.ID)
		rt.mu.Unlock()
	}
	if to != StateTesting && to != StateLive {
		rt.DropBindings(ctx, s, cur.ID) // Bindungen der Mitglieder enden mit dem Event
	}
	if to != StateLive {
		rt.StopRecordings(ctx, s, cur.ID) // Aufzeichnungen genau einmal beenden (Teilaufnahme wird gesichert)
	}
	switch {
	case cur.State == StatePlanned && to == StateTesting:
		wid, err := rt.Prepare(ctx, s, next)
		if err != nil {
			return err
		}
		if err := s.St.SetWorkflow(ctx, cur.ID, wid); err != nil {
			return err
		}
		next.WorkflowID = wid
		rt.ForceApply(cur.ID)
		return rt.StartWorkflow(ctx, wid)
	case cur.State == StateTesting && to == StatePlanned:
		_ = rt.Intercom.Teardown(ctx, cur)
		if cur.WorkflowID != "" {
			return rt.StopWorkflow(ctx, cur.WorkflowID, true)
		}
	case cur.State == StateTesting && to == StateLive:
		if cur.WorkflowID != "" {
			return rt.SetConfirmStop(ctx, s, next)
		}
	case cur.State == StateLive && to == StateTeardown:
		if !confirm {
			return ErrConfirm
		}
		if err := rt.Intercom.Teardown(ctx, cur); err != nil {
			return err
		}
		if cur.WorkflowID != "" {
			return rt.StopWorkflow(ctx, cur.WorkflowID, true)
		}
	case to == StateDone:
		if err := rt.Intercom.Teardown(ctx, cur); err != nil {
			return err
		}
		if cur.WorkflowID != "" {
			if err := rt.DeleteWorkflow(ctx, cur.WorkflowID); err != nil {
				return err
			}
			return s.St.SetWorkflow(ctx, cur.ID, "")
		}
	case to == StateCancelled:
		_ = rt.Intercom.Teardown(ctx, cur)
		if cur.WorkflowID != "" {
			if err := rt.DeleteWorkflow(ctx, cur.WorkflowID); err != nil {
				return err
			}
			return s.St.SetWorkflow(ctx, cur.ID, "")
		}
	}
	return nil
}

func (s *Service) DeleteEvent(ctx context.Context, id, actor string) error {
	cur, err := s.St.GetEvent(ctx, id)
	if err != nil {
		return err
	}
	if !deletable(cur.State) {
		return ErrState
	}
	if err := s.St.DeleteEvent(ctx, id); err != nil {
		return err
	}
	s.audit(actor, id, "event.delete", map[string]any{"name": cur.Name, "state": cur.State})
	return nil
}

func (s *Service) SetMembers(ctx context.Context, id string, ms []Member, actor string) (Event, error) {
	if err := validateMembers(ms); err != nil {
		return Event{}, err
	}
	cur, err := s.St.GetEvent(ctx, id)
	if err != nil {
		return cur, err
	}
	if err := s.St.ReplaceMembers(ctx, id, ms); err != nil {
		return cur, err
	}
	s.audit(actor, id, "event.members", map[string]any{"count": len(ms)})
	return s.GetEvent(ctx, id)
}

// SetLineAvsync ersetzt die Ausgleichs-Einstellungen einer Leitung (Datenbank zuerst, dann der laufende Node).
func (s *Service) SetLineAvsync(ctx context.Context, eventID, lineID string, raw json.RawMessage, actor string) (Event, error) {
	e, err := s.St.GetEvent(ctx, eventID)
	if err != nil {
		return e, err
	}
	if !editable(e.State) {
		return e, ErrState
	}
	idx := -1
	for i := range e.Lines {
		if e.Lines[i].ID == lineID {
			idx = i
		}
	}
	if idx < 0 {
		return e, ErrNotFound
	}
	e.Lines[idx].Avsync = raw
	if err := validateLine(&e.Lines[idx]); err != nil {
		return e, err
	}
	if err := s.St.SetLineAvsync(ctx, eventID, lineID, raw); err != nil {
		return e, err
	}
	s.audit(actor, eventID, "line.avsync", map[string]any{"line": lineID})
	out, err := s.GetEvent(ctx, eventID)
	if err != nil {
		return out, err
	}
	if s.Run != nil && (out.State == StateTesting || out.State == StateLive) {
		if err := s.Run.Refresh(ctx, s, out); err != nil {
			return out, err
		}
		_, _ = s.Run.Reconcile(ctx, s, out)
	}
	return out, nil
}

// StoreAppliedAvsync übernimmt den vom Node gemeldeten, gehaltenen Messwert (`avsync.apply`) in die Datenbank.
func (s *Service) StoreAppliedAvsync(ctx context.Context, eventID, lineID string, heldMs float64) error {
	e, err := s.St.GetEvent(ctx, eventID)
	if err != nil {
		return err
	}
	for _, l := range e.Lines {
		if l.ID != lineID {
			continue
		}
		m := map[string]any{}
		_ = json.Unmarshal(l.Avsync, &m)
		m["heldMs"] = heldMs
		b, _ := json.Marshal(m)
		return s.St.SetLineAvsync(ctx, eventID, lineID, b)
	}
	return ErrNotFound
}

// Precheck prüft, ob die Hosts die Rollen des Events tragen können (Vorschau vor dem Teststart, nur Warnung).
func (s *Service) Precheck(ctx context.Context, id string) (CapacityReport, error) {
	e, err := s.GetEvent(ctx, id)
	if err != nil {
		return CapacityReport{}, err
	}
	if s.Run == nil || s.Run.Capacity == nil {
		return CapacityReport{OK: true, Items: []CapacityItem{}, Hosts: []HostCap{}, Warnings: []string{"Vorprüfung nicht verfügbar."}}, nil
	}
	g, _ := s.GlobalHouse()
	return Precheck(ctx, e, g, s.Run.Capacity, s.ChainConfig())
}

// ---- Einstellungen der Kette ----

// GlobalChain: die globale Kette (null = keine Stufen).
func (s *Service) GlobalChain() json.RawMessage {
	if s.Settings == nil {
		return nil
	}
	b, err := s.Settings.Get(SettingChain)
	if err != nil {
		return nil
	}
	return b
}

// StageTypes: zugelassene Stufen-Typen (Standard: nur der Skalierer).
func (s *Service) StageTypes() []StageType {
	if s.Settings != nil {
		if b, err := s.Settings.Get(SettingStageTypes); err == nil {
			var out []StageType
			if json.Unmarshal(b, &out) == nil && len(out) > 0 {
				return out
			}
		}
	}
	return DefaultStageTypes()
}

// ChainConfig bündelt die globalen Vorgaben für Materialize und Prüfung.
func (s *Service) ChainConfig() ChainConfig {
	return ChainConfig{Global: s.GlobalChain(), Types: s.StageTypes(), Slots: s.FunctionSlots()}
}

// FunctionSlots: eingestellte Node-Typen für Normalizer, Converter und A/V-Delay (Standard: alles im Normalizer).
func (s *Service) FunctionSlots() Slots {
	if s.Settings != nil {
		if b, err := s.Settings.Get(SettingSlots); err == nil {
			var sl Slots
			if json.Unmarshal(b, &sl) == nil {
				return sl.normalized()
			}
		}
	}
	return DefaultSlots()
}

// SetFunctionSlots speichert die Funktionszuordnung; gilt ab dem nächsten Aufbau (laufende Events bleiben unberührt).
func (s *Service) SetFunctionSlots(sl Slots) error {
	if s.Settings == nil {
		return bad("keine Einstellungen verfügbar")
	}
	if err := sl.Validate(); err != nil {
		return err
	}
	b, _ := json.Marshal(sl.normalized())
	return s.Settings.Put(SettingSlots, b)
}

// SetChainSettings speichert die globale Kette und/oder die zugelassenen Typen (nil = unverändert).
func (s *Service) SetChainSettings(chain json.RawMessage, types *[]StageType) error {
	if s.Settings == nil {
		return bad("keine Einstellungen verfügbar")
	}
	cc := s.ChainConfig()
	if types != nil {
		seen := map[string]bool{}
		for _, t := range *types {
			if strings.TrimSpace(t.NodeType) == "" || seen[t.NodeType] || (!t.Video && !t.Audio) {
				return bad("Stufen-Typ „%s“: Node-Typ fehlt, doppelt oder weder Bild noch Ton", t.NodeType)
			}
			seen[t.NodeType] = true
		}
		cc.Types = *types
		b, _ := json.Marshal(*types)
		if err := s.Settings.Put(SettingStageTypes, b); err != nil {
			return err
		}
	}
	if chain != nil {
		if err := ValidateChain("Globale Kette", chain, cc); err != nil {
			return err
		}
		t := strings.TrimSpace(string(chain))
		if t == "null" || t == "" {
			t = "[]"
		}
		if err := s.Settings.Put(SettingChain, []byte(t)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) chainOrEmpty() json.RawMessage {
	if c := s.GlobalChain(); len(c) > 0 {
		return c
	}
	return json.RawMessage("[]")
}

// sameJSON vergleicht zwei JSON-Angaben unabhängig von Leerraum; leer und `null` gelten als gleich.
func sameJSON(a, b json.RawMessage) bool {
	norm := func(r json.RawMessage) string {
		t := strings.TrimSpace(string(r))
		if t == "" || t == "null" {
			return ""
		}
		var v any
		if json.Unmarshal(r, &v) != nil {
			return t
		}
		out, _ := json.Marshal(v)
		return string(out)
	}
	return norm(a) == norm(b)
}

// SettingAlarmRetention: Aufbewahrung beendeter Alarme in Tagen (Standard 30).
const SettingAlarmRetention = "mcr.alarmRetentionDays"

// AlarmRetentionDays liest die Aufbewahrung; ungültig oder fehlend = 30.
func (s *Service) AlarmRetentionDays() int {
	if s.Settings != nil {
		if b, err := s.Settings.Get(SettingAlarmRetention); err == nil {
			var n int
			if json.Unmarshal(b, &n) == nil && n >= 1 && n <= 3650 {
				return n
			}
		}
	}
	return 30
}

// SetAlarmRetentionDays speichert die Aufbewahrung (1…3650 Tage).
func (s *Service) SetAlarmRetentionDays(n int) error {
	if n < 1 || n > 3650 {
		return bad("Aufbewahrung: 1 bis 3650 Tage")
	}
	if s.Settings == nil {
		return bad("keine Einstellungen verfügbar")
	}
	b, _ := json.Marshal(n)
	return s.Settings.Put(SettingAlarmRetention, b)
}

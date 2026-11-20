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
	Lines        []Line          `json:"lines"`
	Members      []Member        `json:"members"`
}

func (s *Service) CreateEvent(ctx context.Context, in NewEventInput, actor string) (Event, error) {
	e := Event{Name: in.Name, TemplateID: in.TemplateID, PlannedStart: in.PlannedStart, PlannedEnd: in.PlannedEnd, Owner: in.Owner, OwnerGroup: in.OwnerGroup,
		HouseFormat: in.HouseFormat, Lines: in.Lines, Members: in.Members}
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
	if replaceLines {
		e.Lines = in.Lines
	}
	if err := s.validateEvent(&e); err != nil {
		return e, err
	}
	if replaceLines && cur.State == StateLive {
		if !sameStructure(cur.Lines, e.Lines) {
			return e, ErrState
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

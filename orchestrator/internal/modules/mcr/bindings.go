package mcr

import (
	"context"
	"log/slog"
	"sort"
)

// Workflow-Bindungen der Event-Mitglieder (106.14): `lead` und `engineer` dürfen die Nodes des Event-Workflows bedienen (`operate`),
// `viewer` ansehen (`view`); Verantwortliche des Events gelten als `lead`. Es werden nur Bindungen **ergänzt** (die Zugriffsregeln des Kerns
// wirken als Freigabeliste und würden Mitgliedern alle anderen Quellen verbergen — deshalb hier bewusst nicht gesetzt). Beim Abbau
// (das Event verlässt Test/Sendung) entfernt der MCR genau die Bindungen, die er angelegt hat.

// Binder legt Bindungen für Nutzer und Gruppen an und entfernt sie (im Orchestrator: der Rechtespeicher `authz`).
type Binder interface {
	BindUser(user, workflowID, verb string) (id string, err error)
	BindGroup(group, workflowID, verb string) (id string, err error)
	Unbind(id string) error
}

// wantedBinding ist eine gewünschte Bindung.
type wantedBinding struct{ SubjectType, Subject, Verb string }

// DesiredBindings: Bindungen aus Mitgliedern und Verantwortlichen. Rein; höchstens eine Bindung je Person/Gruppe (die stärkere).
func DesiredBindings(e Event) []wantedBinding {
	best := map[[2]string]string{}
	rank := map[string]int{"view": 1, "operate": 2}
	set := func(typ, subj, verb string) {
		if subj == "" {
			return
		}
		k := [2]string{typ, subj}
		if rank[verb] > rank[best[k]] {
			best[k] = verb
		}
	}
	set("user", e.Owner, "operate")
	set("group", e.OwnerGroup, "operate")
	for _, m := range e.Members {
		switch m.Role {
		case RoleLead, RoleEngineer:
			set(m.SubjectType, m.Subject, "operate")
		case RoleViewer:
			set(m.SubjectType, m.Subject, "view")
		}
	}
	out := make([]wantedBinding, 0, len(best))
	for k, v := range best {
		out = append(out, wantedBinding{k[0], k[1], v})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		return a.SubjectType+"\x00"+a.Subject < b.SubjectType+"\x00"+b.Subject
	})
	return out
}

type haveBinding struct {
	ID string
	wantedBinding
}

// Store

func (s *Store) EventBindings(ctx context.Context, eventID string) ([]haveBinding, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT binding_id, subject_type, subject, verb FROM mcr_bindings WHERE event_id=$1`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []haveBinding
	for rows.Next() {
		var h haveBinding
		if err := rows.Scan(&h.ID, &h.SubjectType, &h.Subject, &h.Verb); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) AddBinding(ctx context.Context, eventID, bindingID string, w wantedBinding) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO mcr_bindings (event_id, binding_id, subject_type, subject, verb) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, eventID, bindingID, w.SubjectType, w.Subject, w.Verb)
	return err
}

func (s *Store) DropBinding(ctx context.Context, eventID, bindingID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM mcr_bindings WHERE event_id=$1 AND binding_id=$2`, eventID, bindingID)
	return err
}

// ReconcileBindings gleicht die Bindungen des Events mit seinen Mitgliedern ab: fehlende anlegen, überzählige oder geänderte entfernen.
// Nur mit laufendem Workflow (die Bindung gilt dem Workflow).
func (rt *Runtime) ReconcileBindings(ctx context.Context, s *Service, e Event) {
	if rt.Binder == nil || e.WorkflowID == "" || (e.State != StateTesting && e.State != StateLive) {
		return
	}
	have, err := s.St.EventBindings(ctx, e.ID)
	if err != nil {
		return
	}
	want := DesiredBindings(e)
	key := func(w wantedBinding) string { return w.SubjectType + "\x00" + w.Subject + "\x00" + w.Verb }
	wantSet := map[string]wantedBinding{}
	for _, w := range want {
		wantSet[key(w)] = w
	}
	haveSet := map[string]bool{}
	for _, h := range have {
		if _, ok := wantSet[key(h.wantedBinding)]; ok {
			haveSet[key(h.wantedBinding)] = true
			continue
		}
		if err := rt.Binder.Unbind(h.ID); err != nil {
			slog.Warn("mcr: Bindung entfernen", "event", e.ID, "error", err)
			continue
		}
		_ = s.St.DropBinding(ctx, e.ID, h.ID)
	}
	for k, w := range wantSet {
		if haveSet[k] {
			continue
		}
		var id string
		var err error
		if w.SubjectType == "group" {
			id, err = rt.Binder.BindGroup(w.Subject, e.WorkflowID, w.Verb)
		} else {
			id, err = rt.Binder.BindUser(w.Subject, e.WorkflowID, w.Verb)
		}
		if err != nil {
			slog.Warn("mcr: Bindung anlegen", "event", e.ID, "subject", w.Subject, "error", err)
			continue
		}
		if err := s.St.AddBinding(ctx, e.ID, id, w); err != nil {
			slog.Warn("mcr: Bindung merken", "event", e.ID, "error", err)
		}
	}
}

// DropBindings entfernt alle vom MCR angelegten Bindungen des Events (Abbau, Rücknahme, Abbruch).
func (rt *Runtime) DropBindings(ctx context.Context, s *Service, eventID string) {
	if rt.Binder == nil {
		return
	}
	have, err := s.St.EventBindings(ctx, eventID)
	if err != nil {
		return
	}
	for _, h := range have {
		if err := rt.Binder.Unbind(h.ID); err != nil {
			slog.Warn("mcr: Bindung entfernen", "event", eventID, "error", err)
			continue
		}
		_ = s.St.DropBinding(ctx, eventID, h.ID)
	}
}

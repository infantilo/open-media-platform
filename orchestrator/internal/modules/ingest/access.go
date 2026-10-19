package ingest

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte des Moduls (Kapitel 44). Globales `configure` deckt alle ab; Operatoren bekommen genau, was ihnen vergeben wird.
const (
	FeatView           = "ingest.view"            // alle Aufnahmen sehen (ohne: nur die eigenen bzw. die der eigenen Gruppen)
	FeatScheduleCreate = "ingest.schedule.create" // Zeitpläne anlegen
	FeatScheduleEdit   = "ingest.schedule.edit"   // eigene Zeitpläne ändern und beenden
	FeatAdhoc          = "ingest.adhoc.create"    // einmalige Aufnahme starten
	FeatJobControl     = "ingest.job.control"     // eigene Aufträge abbrechen, verschieben, neu zulassen
	FeatAssign         = "ingest.assign"          // Verantwortliche (Person/Gruppe) festlegen
	FeatManageAll      = "ingest.manage_all"      // auch fremde Zeitpläne und Aufträge bearbeiten
)

func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "Aufnahmen", "en": "Recordings"}
	f := func(id, de, en, dde, den string) module.FeatureDef {
		return module.FeatureDef{ID: id, Label: map[string]string{"de": de, "en": en}, Description: map[string]string{"de": dde, "en": den}, Group: g}
	}
	return []module.FeatureDef{
		f(FeatView, "Alle Aufnahmen sehen", "See all recordings", "Ohne dieses Recht sieht die Person nur Aufnahmen, für die sie oder ihre Gruppe verantwortlich ist.", "Without it the person only sees recordings they or their group are responsible for."),
		f(FeatScheduleCreate, "Zeitpläne anlegen", "Create schedules", "Neue (auch wiederkehrende) Aufnahmezeitpläne anlegen.", "Create new (also recurring) recording schedules."),
		f(FeatScheduleEdit, "Eigene Zeitpläne ändern", "Edit own schedules", "Zeitpläne ändern und beenden, für die die Person oder ihre Gruppe verantwortlich ist.", "Change and end schedules the person or their group is responsible for."),
		f(FeatAdhoc, "Einmalige Aufnahme starten", "Start one-off recording", "Eine Aufnahme ohne Zeitplan sofort oder zu einer Zeit planen.", "Plan a recording without a schedule, now or later."),
		f(FeatJobControl, "Eigene Aufträge steuern", "Control own jobs", "Aufträge abbrechen, verschieben und neu zulassen, für die die Person oder ihre Gruppe verantwortlich ist.", "Cancel, move and re-admit jobs the person or their group is responsible for."),
		f(FeatAssign, "Verantwortliche festlegen", "Assign responsibility", "Als Verantwortliche eine andere Person oder eine Gruppe eintragen.", "Name another person or a group as responsible."),
		f(FeatManageAll, "Fremde Aufnahmen bearbeiten", "Manage others' recordings", "Zeitpläne und Aufträge bearbeiten und steuern, für die andere verantwortlich sind (zusätzlich zu den jeweiligen Rechten oben).", "Edit and control schedules and jobs others are responsible for (in addition to the matching rights above)."),
	}
}

// Tiles: die Kachel „Aufnahmen“ des Arbeitsplatzes (dieselbe Ansicht wie der Tab, die Server-Rechte beschränken den Inhalt).
func (*Module) Tiles() []module.UITile {
	return []module.UITile{{
		ID: "recordings", Label: map[string]string{"de": "Aufnahmen", "en": "Recordings"},
		Needs:   []string{"ingest.*"},
		Element: "omp-ingest-view", Bundle: "/dist/modules/ingest.js",
	}}
}

// mayAct: darf die Person den Gegenstand bearbeiten, für den `owner`/`ownerGroup` verantwortlich sind?
func (a *api) mayAct(r *http.Request, owner, ownerGroup string) bool {
	if a.access == nil {
		return true
	}
	id := a.access.Identity(r)
	if id.Has(FeatManageAll) {
		return true
	}
	return (owner != "" && owner == id.User) || (ownerGroup != "" && id.InGroup(ownerGroup))
}

// canSeeAll: sieht die Person alle Aufnahmen (Recht „ingest.view“ bzw. höher)?
func (a *api) canSeeAll(r *http.Request) bool {
	return a.access == nil || a.access.Can(r, FeatView)
}

// mayAssign: darf die Person die Verantwortlichen so festlegen? Sich selbst darf jede(r) eintragen; ein unveränderter Eintrag (Bearbeiten
// eines vorhandenen Zeitplans) ist keine Zuweisung.
func (a *api) mayAssign(r *http.Request, owner, ownerGroup string) bool {
	if a.access == nil {
		return true
	}
	id := a.access.Identity(r)
	if id.Has(FeatAssign) || id.Has(FeatManageAll) {
		return true
	}
	return ownerGroup == "" && (owner == "" || owner == id.User)
}

// ownedBy: gehört der Gegenstand der Person (persönlich oder über eine ihrer Gruppen)?
func ownedBy(id module.Identity, owner, ownerGroup string) bool {
	return (owner != "" && owner == id.User) || (ownerGroup != "" && id.InGroup(ownerGroup))
}

// Tasks: Aufnahmen, für die die Person oder eine ihrer Gruppen verantwortlich ist — laufende, kommende (7 Tage) und
// zuletzt gescheiterte bzw. nicht zugelassene.
func (m *Module) Tasks(ctx context.Context, who module.Identity) ([]module.Task, error) {
	m.mu.Lock()
	svc := m.svc
	m.mu.Unlock()
	if svc == nil {
		return nil, nil
	}
	now := svc.now()
	from, to := now.Add(-3*24*time.Hour), now.Add(7*24*time.Hour)
	jobs, err := svc.St.ListJobs(ctx, JobFilter{From: &from, To: &to, Limit: 500})
	if err != nil {
		return nil, err
	}
	var out []module.Task
	for _, j := range jobs {
		if !ownedBy(who, j.Owner, j.OwnerGroup) || j.State == StCancelled {
			continue
		}
		if j.State == StCompleted && j.PlannedEnd.Before(now.Add(-6*time.Hour)) {
			continue
		}
		t := module.Task{
			ID: j.ID, Kind: "recording", Title: j.Name, State: j.State, Status: jobStatus(j.State),
			Assignee: j.Owner, AssigneeGroup: j.OwnerGroup, Mine: j.Owner == who.User,
			Detail: sourceName(j.Source),
			Action: module.TaskAction{Tab: "ingest", Ref: j.ID},
		}
		start := j.PlannedStart
		t.DueAt = &start
		switch {
		case j.State == StFailed:
			t.Problem, t.ProblemCode = j.Error, "failed"
		case j.State == StBlocked:
			t.Problem, t.ProblemCode = "nicht zugelassen", "not_admitted"
			if j.PlannedStart.Before(now) {
				t.Overdue = true
			}
		case j.State == StWaiting:
			t.Problem, t.ProblemCode = "wartet auf Ressourcen", "waiting_resources"
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, k int) bool { return out[i].DueAt.Before(*out[k].DueAt) })
	return out, nil
}

func sourceName(s Source) string {
	if s.Label != "" {
		return s.Label
	}
	return s.InstanceID
}

func jobStatus(state string) string {
	switch state {
	case StFailed:
		return "error"
	case StBlocked, StWaiting:
		return "warn"
	case StStarting, StRecording, StFinalizing, StProcessing:
		return "active"
	}
	return "ok"
}

func (a *api) ownSchedules(r *http.Request, in []Schedule) []Schedule {
	if a.access == nil {
		return in
	}
	id := a.access.Identity(r)
	var out []Schedule
	for _, s := range in {
		if ownedBy(id, s.Owner, s.OwnerGroup) {
			out = append(out, s)
		}
	}
	return out
}

func (a *api) ownJobs(r *http.Request, in []Job) []Job {
	if a.access == nil {
		return in
	}
	id := a.access.Identity(r)
	var out []Job
	for _, j := range in {
		if ownedBy(id, j.Owner, j.OwnerGroup) {
			out = append(out, j)
		}
	}
	return out
}

func (a *api) forbidOthers(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "Für diese Aufnahme sind Sie nicht verantwortlich (Recht „Fremde Aufnahmen bearbeiten“ fehlt)", "code": "not_responsible"})
}

// checkSchedule: darf die Person den Zeitplan bearbeiten? Schreibt bei „nein“ die Antwort (403/404).
func (a *api) checkSchedule(w http.ResponseWriter, r *http.Request, id string) bool {
	sc, err := a.svc.St.GetSchedule(r.Context(), id)
	if err != nil {
		a.writeErr(w, err)
		return false
	}
	if !a.mayAct(r, sc.Owner, sc.OwnerGroup) {
		a.forbidOthers(w)
		return false
	}
	return true
}

// checkJob: darf die Person den Auftrag steuern?
func (a *api) checkJob(w http.ResponseWriter, r *http.Request, id string) bool {
	j, err := a.svc.St.GetJob(r.Context(), id)
	if err != nil {
		a.writeErr(w, err)
		return false
	}
	if !a.mayAct(r, j.Owner, j.OwnerGroup) {
		a.forbidOthers(w)
		return false
	}
	return true
}

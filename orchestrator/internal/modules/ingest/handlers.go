package ingest

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type api struct {
	svc      *Service
	m        *Module
	settings module.NodeSettings
	nodes    NodeLister
	access   module.Access // Funktionsrechte/Gruppen (nil in Tests: alles erlaubt)
}

func actorOf(r *http.Request) string {
	if u := module.Actor(r); u != "" {
		return u
	}
	return "local"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *api) writeErr(w http.ResponseWriter, err error) {
	body := map[string]any{"error": err.Error()}
	code := http.StatusInternalServerError
	var ve *ValidationError
	switch {
	case errors.Is(err, ErrNotFound):
		code = http.StatusNotFound
	case errors.Is(err, ErrConflict):
		code, body["code"] = http.StatusConflict, "revision_conflict"
	case errors.Is(err, ErrState):
		code, body["code"] = http.StatusConflict, "invalid_state"
	case errors.As(err, &ve):
		code, body["problems"] = http.StatusBadRequest, ve.Problems
	case errors.Is(err, ErrValidation):
		code = http.StatusBadRequest
	default:
		slog.Error("ingest: interner Fehler", "error", err)
		body["error"] = "interner Fehler"
	}
	writeJSON(w, code, body)
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
		return false
	}
	return true
}

func (a *api) listSchedules() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, err := a.svc.St.ListSchedules(r.Context(), r.URL.Query().Get("cancelled") == "1")
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if !a.canSeeAll(r) || r.URL.Query().Get("mine") == "1" {
			s = a.ownSchedules(r, s)
		}
		if s == nil {
			s = []Schedule{}
		}
		writeJSON(w, 200, map[string]any{"schedules": s})
	}
}

func (a *api) createSchedule() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in ScheduleInput
		if !readBody(w, r, &in) {
			return
		}
		if !a.mayAssign(r, in.Owner, in.OwnerGroup) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Verantwortliche festlegen darf nur, wer das Recht „Verantwortliche festlegen“ hat"})
			return
		}
		sc, err := a.svc.CreateSchedule(r.Context(), in, actorOf(r))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		jobs, _ := a.svc.St.ListJobs(r.Context(), JobFilter{ScheduleID: sc.ID})
		writeJSON(w, 201, map[string]any{"schedule": sc, "jobs": jobs})
	}
}

func (a *api) getSchedule() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, err := a.svc.St.GetSchedule(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if !a.canSeeAll(r) && !a.mayAct(r, sc.Owner, sc.OwnerGroup) {
			a.forbidOthers(w)
			return
		}
		jobs, _ := a.svc.St.ListJobs(r.Context(), JobFilter{ScheduleID: sc.ID, Limit: 100})
		writeJSON(w, 200, map[string]any{"schedule": sc, "jobs": jobs})
	}
}

type revInput struct {
	ScheduleInput
	ExpectedRevision int `json:"expectedRevision"`
}

func (a *api) updateSchedule() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in revInput
		if !readBody(w, r, &in) {
			return
		}
		if !a.checkSchedule(w, r, r.PathValue("id")) {
			return
		}
		if old, e := a.svc.St.GetSchedule(r.Context(), r.PathValue("id")); e == nil && (in.Owner != old.Owner || in.OwnerGroup != old.OwnerGroup) &&
			(in.Owner != "" || in.OwnerGroup != "") && !a.mayAssign(r, in.Owner, in.OwnerGroup) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Verantwortliche ändern darf nur, wer das Recht „Verantwortliche festlegen“ hat"})
			return
		}
		sc, err := a.svc.UpdateSchedule(r.Context(), r.PathValue("id"), in.ScheduleInput, in.ExpectedRevision, actorOf(r))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"schedule": sc})
	}
}

func (a *api) deleteSchedule() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.checkSchedule(w, r, r.PathValue("id")) {
			return
		}
		abort := r.URL.Query().Get("abort") == "1"
		if err := a.svc.CancelSchedule(r.Context(), r.PathValue("id"), actorOf(r), abort); err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// previewSchedule: die nächsten Vorkommen (inkl. Zeitumstellungs-Hinweisen) — Grundlage der Vorschau im Formular.
func (a *api) previewSchedule() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc, err := a.svc.St.GetSchedule(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		occ, err := Occurrences(sc.Spec, time.Now(), time.Now().Add(60*24*time.Hour))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if len(occ) > 20 {
			occ = occ[:20]
		}
		writeJSON(w, 200, map[string]any{"occurrences": occ})
	}
}

func (a *api) listJobs() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := JobFilter{ScheduleID: q.Get("scheduleId")}
		if s := q.Get("state"); s != "" {
			f.States = strings.Split(s, ",")
		}
		if t, err := time.Parse(time.RFC3339, q.Get("from")); err == nil {
			f.From = &t
		}
		if t, err := time.Parse(time.RFC3339, q.Get("to")); err == nil {
			f.To = &t
		}
		if n, err := strconv.Atoi(q.Get("limit")); err == nil {
			f.Limit = n
		}
		jobs, err := a.svc.St.ListJobs(r.Context(), f)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if !a.canSeeAll(r) || q.Get("mine") == "1" {
			jobs = a.ownJobs(r, jobs)
		}
		if jobs == nil {
			jobs = []Job{}
		}
		writeJSON(w, 200, map[string]any{"jobs": jobs})
	}
}

func (a *api) getJob() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		j, err := a.svc.St.GetJob(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		if !a.canSeeAll(r) && !a.mayAct(r, j.Owner, j.OwnerGroup) {
			a.forbidOthers(w)
			return
		}
		ev, _ := a.svc.St.Events(r.Context(), j.ID)
		if ev == nil {
			ev = []Event{}
		}
		writeJSON(w, 200, map[string]any{"job": j, "events": ev})
	}
}

type jobAction struct {
	ExpectedRevision *int       `json:"expectedRevision"`
	Abort            bool       `json:"abort"`
	Start            *time.Time `json:"start"`
	DurationS        int64      `json:"durationS"`
}

func (j jobAction) rev() int {
	if j.ExpectedRevision == nil {
		return -1
	}
	return *j.ExpectedRevision
}

func (a *api) cancelJob() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in jobAction
		if !readBody(w, r, &in) {
			return
		}
		if !a.checkJob(w, r, r.PathValue("id")) {
			return
		}
		j, err := a.svc.CancelJob(r.Context(), r.PathValue("id"), actorOf(r), in.Abort, in.rev())
		if err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"job": j})
	}
}

func (a *api) rescheduleJob() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in jobAction
		if !readBody(w, r, &in) {
			return
		}
		if in.Start == nil {
			a.writeErr(w, &ValidationError{Problems: []string{"Startzeit fehlt"}})
			return
		}
		if !a.checkJob(w, r, r.PathValue("id")) {
			return
		}
		d, j, err := a.svc.RescheduleJob(r.Context(), r.PathValue("id"), actorOf(r), *in.Start, in.DurationS, in.rev())
		if err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"job": j, "decision": d})
	}
}

func (a *api) readmit() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.checkJob(w, r, r.PathValue("id")) {
			return
		}
		d, j, err := a.svc.Admit(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"job": j, "decision": d})
	}
}

func (a *api) adhoc() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in AdHocInput
		if !readBody(w, r, &in) {
			return
		}
		if !a.mayAssign(r, in.Owner, in.OwnerGroup) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Verantwortliche festlegen darf nur, wer das Recht „Verantwortliche festlegen“ hat"})
			return
		}
		j, d, err := a.svc.CreateAdHoc(r.Context(), in, actorOf(r))
		if err != nil {
			a.writeErr(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"job": j, "decision": d})
	}
}

// plan: Trockenlauf der Zulassung (nichts wird gespeichert) — zeigt Engpässe, bevor jemand speichert.
func (a *api) plan() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in AdHocInput
		if !readBody(w, r, &in) {
			return
		}
		now := a.svc.now()
		start := now.Add(5 * time.Second)
		if in.Start != nil {
			start = in.Start.UTC()
		}
		si := ScheduleInput{Name: "plan", Source: in.Source, Spec: Spec{TZ: "UTC", StartLocal: start.Format(localLayout), DurationS: in.DurationS}, ProfileID: in.ProfileID, Priority: in.Priority, HostPref: in.HostPref}
		if err := a.svc.validate(&si); err != nil {
			a.writeErr(w, err)
			return
		}
		cfg := a.svc.Cfg()
		prio := 5
		if in.Priority != nil {
			prio = *in.Priority
		}
		dur := time.Duration(in.DurationS) * time.Second
		st, _ := a.svc.St.Stats(r.Context(), in.ProfileID)
		demand := EffectiveDemand(cfg.Profiles[in.ProfileID], st, dur.Seconds())
		booked, err := a.svc.St.Booked(r.Context(), now)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		d := Plan(Request{JobID: "plan", Source: in.Source.Key(), Start: start, End: start.Add(dur), Priority: prio, Demand: demand, HostPref: in.HostPref, Needs: []string{"recorder"}},
			a.svc.CapacityHosts(r.Context()), booked, cfg.planRules(), now)
		writeJSON(w, 200, map[string]any{"decision": d, "demand": demand})
	}
}

// capacity: je Host und Ressourcenart die gebuchte Nutzung über den Zeitraum, harte Grenzen, Engpässe und Warnungen — bewusst keine
// einzelne Gesamtprozentzahl.
func (a *api) capacity() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		now := a.svc.now()
		from, to := now, now.Add(24*time.Hour)
		if t, err := time.Parse(time.RFC3339, r.URL.Query().Get("from")); err == nil {
			from = t
		}
		if t, err := time.Parse(time.RFC3339, r.URL.Query().Get("to")); err == nil {
			to = t
		}
		if to.Sub(from) > 14*24*time.Hour || !to.After(from) {
			a.writeErr(w, &ValidationError{Problems: []string{"Zeitraum muss zwischen 0 und 14 Tagen liegen"}})
			return
		}
		ctx := r.Context()
		hosts := a.svc.CapacityHosts(ctx)
		booked, err := a.svc.St.Booked(ctx, from)
		if err != nil {
			a.writeErr(w, err)
			return
		}
		type hostView struct {
			HostCap
			Usage    []UsagePoint `json:"usage"`
			Warnings []Verdict    `json:"warnings"`
		}
		var hv []hostView
		for _, h := range hosts {
			v := hostView{HostCap: h, Usage: UsageTimeline(h, booked, from, to), Warnings: []Verdict{}}
			if v.Usage == nil {
				v.Usage = []UsagePoint{}
			}
			for _, u := range v.Usage {
				for _, res := range ResourceKinds {
					hard, ok := h.Hard[res]
					if !ok || hard <= 0 || res == ResDiskGB {
						continue
					}
					frac := u.Use[res] / hard
					switch {
					case frac > 1+1e-9:
						v.Warnings = append(v.Warnings, Verdict{Kind: VHardShortage, Blocking: true, Resource: res, Host: h.ID, From: tp(u.From), To: tp(u.To), Jobs: u.Jobs, Needed: u.Use[res], Available: hard,
							Message: res + " über der harten Grenze (sollte durch die Zulassung unmöglich sein — Budget nachträglich gesenkt?)"})
					case h.SoftFrac > 0 && frac > h.SoftFrac+1e-9:
						v.Warnings = append(v.Warnings, Verdict{Kind: VSoftWarning, Resource: res, Host: h.ID, From: tp(u.From), To: tp(u.To), Jobs: u.Jobs, Needed: u.Use[res], Available: hard,
							Message: res + ": hohe Belegung im Zeitraum"})
					}
				}
			}
			hv = append(hv, v)
		}
		jobs, _ := a.svc.St.ListJobs(ctx, JobFilter{States: []string{StBlocked, StScheduled, StWaiting, StStarting, StRecording, StFinalizing, StProcessing}, From: &from, To: &to, Limit: 500})
		if !a.canSeeAll(r) { // ohne „alle sehen“: nur die eigenen Aufträge (die Auslastung der Hosts bleibt sichtbar)
			jobs = a.ownJobs(r, jobs)
		}
		if jobs == nil {
			jobs = []Job{}
		}
		sort.SliceStable(jobs, func(i, k int) bool { return jobs[i].PlannedStart.Before(jobs[k].PlannedStart) })
		type problem struct {
			Job      Job       `json:"job"`
			Verdicts []Verdict `json:"verdicts"`
		}
		var problems []problem
		for _, j := range jobs {
			if j.State == StBlocked && len(j.Verdicts) > 0 {
				problems = append(problems, problem{Job: j, Verdicts: j.Verdicts})
			}
		}
		if problems == nil {
			problems = []problem{}
		}
		writeJSON(w, 200, map[string]any{"from": from, "to": to, "hosts": hv, "resources": ResourceKinds, "jobs": jobs, "problems": problems,
			"config": map[string]any{"leadTimeS": a.svc.Cfg().LeadTimeS, "maxStartDeviationS": a.svc.Cfg().MaxStartDeviationS}})
	}
}

// sources: auswählbare Quellen (laufende Nodes mit Sendern).
func (a *api) sources() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		type src struct {
			InstanceID string `json:"instanceId"`
			NodeLabel  string `json:"nodeLabel"`
			Online     bool   `json:"online"`
			Senders    []struct {
				ID     string `json:"id"`
				Label  string `json:"label"`
				Format string `json:"format"`
			} `json:"senders"`
		}
		out := []src{}
		if a.nodes != nil {
			for _, n := range a.nodes.List() {
				if n.InstanceID == "" || len(n.Senders) == 0 {
					continue
				}
				s := src{InstanceID: n.InstanceID, NodeLabel: n.Label, Online: n.Online}
				for _, sn := range n.Senders {
					s.Senders = append(s.Senders, struct {
						ID     string `json:"id"`
						Label  string `json:"label"`
						Format string `json:"format"`
					}{sn.ID, sn.Label, sn.Format})
				}
				out = append(out, s)
			}
		}
		writeJSON(w, 200, map[string]any{"sources": out})
	}
}

func (a *api) getConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.svc.Cfg()) }
}

func (a *api) putConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "Körper nicht lesbar"})
			return
		}
		c, err := ParseConfig(raw)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		out, _ := json.Marshal(c)
		if err := a.settings.Put(settingsKey, out); err != nil {
			a.writeErr(w, err)
			return
		}
		a.m.cfg.Invalidate()
		a.svc.audit(actorOf(r), "", "config_changed", nil)
		writeJSON(w, 200, c)
	}
}

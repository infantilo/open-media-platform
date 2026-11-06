package radio

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type api struct {
	m      *Module
	access module.Access
	audit  module.DomainAudit
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

func writeErr(w http.ResponseWriter, err error) {
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
	case errors.Is(err, ErrForbidden):
		code = http.StatusForbidden
	case errors.As(err, &ve):
		code, body["problems"] = http.StatusBadRequest, ve.Problems
	case errors.Is(err, ErrValidation):
		code = http.StatusBadRequest
	default:
		slog.Error("radio: interner Fehler", "error", err)
		body["error"] = "interner Fehler"
	}
	writeJSON(w, code, body)
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxContentBytes+(256<<10))
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
		return false
	}
	return true
}

func (a *api) log(r *http.Request, id, action string, details map[string]any) {
	if a.audit != nil {
		a.audit.Log(actorOf(r), "radio_show", id, action, details)
	}
}

// mayEdit: darf die Person diese Sendung ändern (Besitz, Moderation, oder Recht „fremde bearbeiten“)?
func (a *api) mayEdit(r *http.Request, s Show) bool {
	if a.access == nil {
		return true
	}
	id := a.access.Identity(r)
	if id.Has(FeatManageAll) {
		return true
	}
	if s.Owner != "" && s.Owner == id.User {
		return true
	}
	for _, p := range s.Presenters {
		if p == id.User {
			return true
		}
	}
	return false
}

func (a *api) can(r *http.Request, feature string) bool {
	return a.access == nil || a.access.Can(r, feature)
}

func (a *api) list() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := Filter{Status: q.Get("status")}
		if v := q.Get("template"); v != "" {
			b := v == "1" || v == "true"
			f.Template = &b
		}
		for key, dst := range map[string]**time.Time{"from": &f.From, "to": &f.To} {
			if v := q.Get(key); v != "" {
				t, err := time.Parse(time.RFC3339, v)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]any{"error": key + ": RFC 3339 erwartet"})
					return
				}
				*dst = &t
			}
		}
		if q.Get("mine") == "1" {
			f.User = module.Actor(r)
		}
		list, err := a.m.store().List(r.Context(), f)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func (a *api) get() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, err := a.m.store().Get(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s)
	}
}

// current: die laufende Sendung, sonst die, deren Zeitfenster jetzt gilt (freigegeben), sonst die nächste freigegebene.
func (a *api) current() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		st := a.m.store()
		no := false
		now := time.Now()
		live, err := st.List(r.Context(), Filter{Status: StatusLive, Template: &no})
		if err != nil {
			writeErr(w, err)
			return
		}
		pick := func(l []Show) *Show {
			if len(l) == 0 {
				return nil
			}
			return &l[0]
		}
		var found *Show
		if found = pick(live); found == nil {
			ready, err := st.List(r.Context(), Filter{Status: StatusReady, Template: &no, From: &now})
			if err != nil {
				writeErr(w, err)
				return
			}
			// nach Beginn sortiert: das erste, dessen Fenster läuft oder das als nächstes beginnt
			found = pick(ready)
		}
		if found == nil {
			writeJSON(w, http.StatusOK, map[string]any{"show": nil})
			return
		}
		full, err := st.Get(r.Context(), found.ID)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"show": full})
	}
}

func (a *api) create() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in Input
		if !readBody(w, r, &in) {
			return
		}
		s, err := a.m.store().Create(r.Context(), in, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, s.ID, "create", map[string]any{"title": s.Title, "template": s.Template})
		writeJSON(w, http.StatusCreated, s)
	}
}

func (a *api) update() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		cur, err := a.m.store().Get(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !a.mayEdit(r, cur) {
			writeErr(w, ErrForbidden)
			return
		}
		var in Input
		if !readBody(w, r, &in) {
			return
		}
		s, err := a.m.store().Update(r.Context(), id, in, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, id, "update", map[string]any{"version": s.RowVersion, "reason": in.Reason})
		writeJSON(w, http.StatusOK, s)
	}
}

func (a *api) delete() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		cur, err := a.m.store().Get(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !a.mayEdit(r, cur) {
			writeErr(w, ErrForbidden)
			return
		}
		if err := a.m.store().Delete(r.Context(), id); err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, id, "delete", map[string]any{"title": cur.Title})
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *api) setStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var body struct {
			Status string `json:"status"`
		}
		if !readBody(w, r, &body) {
			return
		}
		cur, err := a.m.store().Get(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if needsRelease(body.Status) {
			if !a.can(r, FeatRelease) {
				writeErr(w, ErrForbidden)
				return
			}
		} else if !a.mayEdit(r, cur) {
			writeErr(w, ErrForbidden)
			return
		}
		s, err := a.m.store().SetStatus(r.Context(), id, body.Status, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, id, "status", map[string]any{"from": cur.Status, "to": s.Status})
		writeJSON(w, http.StatusOK, s)
	}
}

func (a *api) duplicate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in Input
		if !readBody(w, r, &in) {
			return
		}
		s, err := a.m.store().Duplicate(r.Context(), r.PathValue("id"), in, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, s.ID, "duplicate", map[string]any{"from": r.PathValue("id")})
		writeJSON(w, http.StatusCreated, s)
	}
}

func (a *api) versions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, err := a.m.store().Get(r.Context(), id); err != nil {
			writeErr(w, err)
			return
		}
		v, err := a.m.store().Versions(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func versionParam(r *http.Request) (int, bool) {
	n, err := strconv.Atoi(r.PathValue("version"))
	return n, err == nil && n > 0
}

func (a *api) version() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, ok := versionParam(r)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "version: Zahl erwartet"})
			return
		}
		v, err := a.m.store().GetVersion(r.Context(), r.PathValue("id"), n)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// restore: macht einen früheren Stand zum neuen aktuellen Stand (als neue Version, der Verlauf bleibt).
func (a *api) restore() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		n, ok := versionParam(r)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "version: Zahl erwartet"})
			return
		}
		st := a.m.store()
		cur, err := st.Get(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !a.mayEdit(r, cur) {
			writeErr(w, ErrForbidden)
			return
		}
		v, err := st.GetVersion(r.Context(), id, n)
		if err != nil {
			writeErr(w, err)
			return
		}
		in := Input{Title: cur.Title, Description: cur.Description, Template: cur.Template, SlotStart: cur.SlotStart, SlotEnd: cur.SlotEnd,
			Presenters: cur.Presenters, Tags: cur.Tags, Content: v.Content, RowVersion: cur.RowVersion, Reason: "wiederhergestellt aus Version " + strconv.Itoa(n)}
		s, err := st.Update(r.Context(), id, in, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.log(r, id, "restore", map[string]any{"fromVersion": n, "version": s.RowVersion})
		writeJSON(w, http.StatusOK, s)
	}
}

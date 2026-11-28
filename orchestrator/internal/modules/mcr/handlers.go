package mcr

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type api struct {
	svc    *Service
	access module.Access
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
	case errors.Is(err, ErrForbidden):
		code, body["code"] = http.StatusForbidden, "forbidden"
	case errors.Is(err, ErrConfirm):
		code, body["code"] = http.StatusConflict, "confirmation_required"
	case errors.Is(err, ErrState):
		code, body["code"] = http.StatusConflict, "invalid_state"
	case errors.As(err, &ve):
		code, body["problems"] = http.StatusBadRequest, ve.Problems
	case errors.Is(err, ErrValidation):
		code = http.StatusBadRequest
	default:
		slog.Error("mcr: interner Fehler", "error", err)
		body["error"] = "interner Fehler"
	}
	writeJSON(w, code, body)
}

func readBody(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return bad("kein gültiges JSON: %v", err)
	}
	return nil
}

func (a *api) listTemplates() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out, err := a.svc.St.ListTemplates(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"templates": out})
	}
}

func (a *api) createTemplate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var t Template
		if err := readBody(r, &t); err != nil {
			writeErr(w, err)
			return
		}
		if err := a.svc.ValidateTemplate(&t); err != nil {
			writeErr(w, err)
			return
		}
		out, err := a.svc.St.CreateTemplate(r.Context(), t, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		a.svc.audit(actorOf(r), out.ID, "template.create", map[string]any{"name": out.Name})
		writeJSON(w, 201, out)
	}
}

func (a *api) updateTemplate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var t Template
		if err := readBody(r, &t); err != nil {
			writeErr(w, err)
			return
		}
		t.ID = r.PathValue("id")
		if err := a.svc.ValidateTemplate(&t); err != nil {
			writeErr(w, err)
			return
		}
		out, err := a.svc.St.UpdateTemplate(r.Context(), t)
		if err != nil {
			writeErr(w, err)
			return
		}
		a.svc.audit(actorOf(r), out.ID, "template.update", map[string]any{"name": out.Name})
		writeJSON(w, 200, out)
	}
}

func (a *api) deleteTemplate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := a.svc.St.DeleteTemplate(r.Context(), id); err != nil {
			writeErr(w, err)
			return
		}
		a.svc.audit(actorOf(r), id, "template.delete", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *api) listEvents() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out, err := a.svc.St.ListEvents(r.Context(), strings.TrimSpace(r.URL.Query().Get("state")))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"events": a.visibleEvents(r.Context(), r, out), "lifecycle": Graph()})
	}
}

func (a *api) createEvent() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in NewEventInput
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		out, err := a.svc.CreateEvent(r.Context(), in, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 201, out)
	}
}

func (a *api) getEvent() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out, ok := a.authorize(w, r, r.PathValue("id"), ActView)
		if !ok {
			return
		}
		acc := AccessOf(a.actor(r), out)
		out.Access = &acc
		writeJSON(w, 200, out)
	}
}

// wall liefert die Multiview-Wand; `?watch=id1,id2` nennt Events, deren Bild gerade angezeigt wird.
func (a *api) wall() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.svc.Run == nil {
			writeJSON(w, 200, map[string]any{"events": []any{}})
			return
		}
		var watch []string
		if v := r.URL.Query().Get("watch"); v != "" {
			watch = strings.Split(v, ",")
		}
		who := a.actor(r)
		out, err := a.svc.Run.WallFor(r.Context(), a.svc, watch, a.visibleTo(r), func(e Event) *EventAccess {
			acc := AccessOf(who, e)
			return &acc
		})
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"events": out})
	}
}

// station routet eine Leitung zum Abhören oder auf das Messgerät.
func (a *api) station() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Action string `json:"action"`
		}
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		e, ok := a.authorize(w, r, r.PathValue("id"), ActTest)
		if !ok {
			return
		}
		if a.svc.Run == nil || (e.State != StateTesting && e.State != StateLive) {
			writeErr(w, ErrState)
			return
		}
		out, err := a.svc.Run.StationRoute(r.Context(), a.svc, e, r.PathValue("lineId"), in.Action)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) precheck() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.authorize(w, r, r.PathValue("id"), ActView); !ok {
			return
		}
		out, err := a.svc.Precheck(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) updateEvent() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		var in NewEventInput
		body := http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(body).Decode(&raw); err != nil {
			writeErr(w, bad("kein gültiges JSON: %v", err))
			return
		}
		b, _ := json.Marshal(raw)
		if err := json.Unmarshal(b, &in); err != nil {
			writeErr(w, bad("ungültige Felder: %v", err))
			return
		}
		if _, ok := a.authorize(w, r, r.PathValue("id"), ActEdit); !ok {
			return
		}
		_, replace := raw["lines"]
		out, err := a.svc.UpdateEvent(r.Context(), r.PathValue("id"), in, replace, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) deleteEvent() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.authorize(w, r, r.PathValue("id"), ActEdit); !ok {
			return
		}
		if err := a.svc.DeleteEvent(r.Context(), r.PathValue("id"), actorOf(r)); err != nil {
			writeErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *api) transition() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			To      string `json:"to"`
			Confirm bool   `json:"confirm"`
		}
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		cur, ok := a.authorize(w, r, r.PathValue("id"), ActView)
		if !ok {
			return
		}
		if !Allowed(a.actor(r), cur, TransitionAction(cur.State, in.To)) {
			writeErr(w, ErrForbidden)
			return
		}
		out, err := a.svc.Transition(r.Context(), r.PathValue("id"), in.To, actorOf(r), in.Confirm)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) putMembers() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Members []Member `json:"members"`
		}
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		if _, ok := a.authorize(w, r, r.PathValue("id"), ActMembers); !ok {
			return
		}
		out, err := a.svc.SetMembers(r.Context(), r.PathValue("id"), in.Members, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) getSettings() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h, err := a.svc.GlobalHouse()
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"houseFormat": h, "chain": a.svc.chainOrEmpty(), "stageTypes": a.svc.StageTypes(), "slots": a.svc.FunctionSlots(), "alarmRetentionDays": a.svc.AlarmRetentionDays()})
	}
}

func (a *api) putSettings() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Nur gesendete Teile ändern: ein fehlendes Feld lässt den Wert unberührt.
		var in map[string]json.RawMessage
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		if raw, ok := in["houseFormat"]; ok {
			if err := a.svc.SetGlobalHouse(raw); err != nil {
				writeErr(w, err)
				return
			}
			a.svc.audit(actorOf(r), "settings", "settings.houseFormat", nil)
		}
		if raw, ok := in["alarmRetentionDays"]; ok {
			var n int
			if err := json.Unmarshal(raw, &n); err != nil {
				writeErr(w, bad("alarmRetentionDays: %v", err))
				return
			}
			if err := a.svc.SetAlarmRetentionDays(n); err != nil {
				writeErr(w, err)
				return
			}
		}
		if raw, ok := in["slots"]; ok {
			var sl Slots
			if err := json.Unmarshal(raw, &sl); err != nil {
				writeErr(w, bad("slots: %v", err))
				return
			}
			if err := a.svc.SetFunctionSlots(sl); err != nil {
				writeErr(w, err)
				return
			}
			a.svc.audit(actorOf(r), "settings", "settings.slots", nil)
		}
		chain, hasChain := in["chain"]
		var types *[]StageType
		if raw, ok := in["stageTypes"]; ok {
			var ts []StageType
			if err := json.Unmarshal(raw, &ts); err != nil {
				writeErr(w, bad("stageTypes: %v", err))
				return
			}
			types = &ts
		}
		if hasChain || types != nil {
			if !hasChain {
				chain = nil
			}
			if err := a.svc.SetChainSettings(chain, types); err != nil {
				writeErr(w, err)
				return
			}
			a.svc.audit(actorOf(r), "settings", "settings.chain", nil)
		}
		h, _ := a.svc.GlobalHouse()
		writeJSON(w, 200, map[string]any{"houseFormat": h, "chain": a.svc.chainOrEmpty(), "stageTypes": a.svc.StageTypes(), "slots": a.svc.FunctionSlots(), "alarmRetentionDays": a.svc.AlarmRetentionDays()})
	}
}

// ---- Laufzeit: Zustand, Messung, Ausgleich (106.10) ----

func (a *api) noRuntime(w http.ResponseWriter) bool {
	if a.svc.Run == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Laufzeit nicht angebunden", "code": "no_runtime"})
		return true
	}
	return false
}

// status: Zustand je Leitung aus den Node-Parametern, ein Aufruf statt vieler Einzelabfragen.
func (a *api) status() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, ok := a.authorize(w, r, r.PathValue("id"), ActView)
		if !ok {
			return
		}
		if a.svc.Run == nil {
			writeJSON(w, 200, map[string]any{"eventId": e.ID, "state": e.State, "lines": []any{}})
			return
		}
		// Kein `Watch`: der Status zeigt kein Bild. Den (teuren) Multiviewer hält nur die Wand bereit, solange sie sein Bild zeigt.
		out, err := a.svc.Run.Status(r.Context(), a.svc, e)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

// measure startet die A/V-Messung am Normalizer der Leitung (`avsync.measure`).
func (a *api) measure() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.noRuntime(w) {
			return
		}
		var in struct {
			Seconds float64 `json:"seconds"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
		if in.Seconds <= 0 {
			in.Seconds = 10
		}
		e, ok := a.authorize(w, r, r.PathValue("id"), ActTest)
		if !ok {
			return
		}
		inst, err := a.svc.Run.NormalizerInstance(a.svc, e, r.PathValue("lineId"))
		if err != nil {
			writeErr(w, err)
			return
		}
		if err := a.svc.Run.CallNormalizer(r.Context(), inst, "avsync.measure", map[string]any{"seconds": in.Seconds}); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		a.svc.audit(actorOf(r), e.ID, "line.measure", map[string]any{"line": r.PathValue("lineId"), "seconds": in.Seconds})
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "seconds": in.Seconds})
	}
}

// putAvsync speichert die Ausgleichs-Einstellungen einer Leitung in der Datenbank und gibt sie an den laufenden Node.
func (a *api) putAvsync() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw json.RawMessage
		if err := readBody(r, &raw); err != nil {
			writeErr(w, err)
			return
		}
		if _, ok := a.authorize(w, r, r.PathValue("id"), ActTest); !ok {
			return
		}
		out, err := a.svc.SetLineAvsync(r.Context(), r.PathValue("id"), r.PathValue("lineId"), raw, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

func (a *api) pipLock() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Lock string `json:"lock"`
		}
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		e, ok := a.authorize(w, r, r.PathValue("id"), ActTest)
		if !ok {
			return
		}
		if a.svc.Run == nil || (e.State != StateTesting && e.State != StateLive) {
			writeErr(w, ErrState)
			return
		}
		if in.Lock != "" {
			found := false
			for _, l := range e.Lines {
				if l.ID == in.Lock {
					found = true
				}
			}
			if !found {
				writeErr(w, ErrNotFound)
				return
			}
		}
		a.svc.Run.PipLock(e.ID, in.Lock)
		a.svc.audit(actorOf(r), e.ID, "alarmpip.lock", map[string]any{"line": in.Lock})
		writeJSON(w, 200, map[string]any{"lock": in.Lock})
	}
}

package mcr

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type api struct{ svc *Service }

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
		writeJSON(w, 200, map[string]any{"events": out, "lifecycle": Graph()})
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
		out, err := a.svc.GetEvent(r.Context(), r.PathValue("id"))
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
		writeJSON(w, 200, map[string]any{"houseFormat": h})
	}
}

func (a *api) putSettings() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			HouseFormat json.RawMessage `json:"houseFormat"`
		}
		if err := readBody(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		if err := a.svc.SetGlobalHouse(in.HouseFormat); err != nil {
			writeErr(w, err)
			return
		}
		a.svc.audit(actorOf(r), "settings", "settings.houseFormat", nil)
		h, _ := a.svc.GlobalHouse()
		writeJSON(w, 200, map[string]any{"houseFormat": h})
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
		e, err := a.svc.GetEvent(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		if a.svc.Run == nil {
			writeJSON(w, 200, map[string]any{"eventId": e.ID, "state": e.State, "lines": []any{}})
			return
		}
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
		e, err := a.svc.GetEvent(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
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
		out, err := a.svc.SetLineAvsync(r.Context(), r.PathValue("id"), r.PathValue("lineId"), raw, actorOf(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	}
}

package intercom

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
	var ve *ValidationError
	switch {
	case errors.As(err, &ve):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": ve.Error(), "problems": ve.Problems})
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
	default:
		slog.Error("intercom: interner Fehler", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "interner Fehler"})
	}
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
		return false
	}
	return true
}

func (a *api) getConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.svc.load()
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.Redacted())
	}
}

func (a *api) putConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in Config
		if !readBody(w, r, &in) {
			return
		}
		c, err := a.svc.Update(r.Context(), actorOf(r), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.Redacted())
	}
}

func (a *api) rotate() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültige ID"})
			return
		}
		if err := a.svc.RotateToken(r.Context(), actorOf(r), id); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type guestOut struct {
	ID      int       `json:"id"`
	Name    string    `json:"name"`
	Expires time.Time `json:"expires"`
	URL     string    `json:"url,omitempty"`
	Routes  []Route   `json:"routes"`
}

func (a *api) guestOut(r *http.Request, g Guest) guestOut {
	out := guestOut{ID: g.ID, Name: g.Name, Expires: g.Expires, Routes: g.Routes}
	if u, err := a.svc.PanelURL(r.Context(), r.Host, g.Token); err == nil {
		out.URL = u
	}
	return out
}

func (a *api) listGuests() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.svc.load()
		if err != nil {
			writeErr(w, err)
			return
		}
		out := []guestOut{}
		for _, g := range c.ActiveGuests(a.svc.now()) {
			out = append(out, a.guestOut(r, g))
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func (a *api) createGuest() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name       string  `json:"name"`
			Routes     []Route `json:"routes"`
			TTLMinutes int     `json:"ttl_minutes"`
		}
		if !readBody(w, r, &in) {
			return
		}
		g, err := a.svc.CreateGuest(r.Context(), actorOf(r), in.Name, in.Routes, time.Duration(in.TTLMinutes)*time.Minute)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, a.guestOut(r, g))
	}
}

func (a *api) deleteGuest() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültige ID"})
			return
		}
		if err := a.svc.DeleteGuest(r.Context(), actorOf(r), id); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// panels: die Sprechstellen, die die anfragende Person öffnen darf, samt Link.
func (a *api) panels() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.svc.load()
		if err != nil {
			writeErr(w, err)
			return
		}
		user := module.Actor(r)
		var groups []string
		admin := true // Bootstrap/ohne Rechte-Speicher: alles erlaubt
		if a.access != nil {
			id := a.access.Identity(r)
			user, groups = id.User, id.Groups
			admin = a.access.Can(r, FeatAdmin)
		}
		parties := c.PartiesFor(user, groups)
		if admin && user == "" { // Bootstrap-Modus: keine Personen, daher alle zeigen
			parties = nil
			for _, p := range c.Parties {
				if p.Kind != "program" && p.Kind != "port" {
					parties = append(parties, p)
				}
			}
		}
		type panel struct {
			PartyID int    `json:"party_id"`
			Name    string `json:"name"`
			Kind    string `json:"kind"`
			URL     string `json:"url"`
		}
		out := []panel{}
		var urlErr string
		for _, p := range parties {
			u, err := a.svc.PanelURL(r.Context(), r.Host, p.Token)
			if err != nil {
				urlErr = err.Error()
				break
			}
			out = append(out, panel{PartyID: p.ID, Name: p.Name, Kind: p.Kind, URL: u})
		}
		resp := map[string]any{"panels": out}
		if urlErr != "" {
			resp["error"] = urlErr
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func (a *api) status() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := a.svc.Status(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	}
}

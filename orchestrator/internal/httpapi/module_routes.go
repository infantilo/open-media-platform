package httpapi

import (
	"bytes"
	"io"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// moduleRoutes hängt die Rechteprüfung des Kerns vor die Routen eines Moduls (UMSETZUNG.md Kapitel 36). Module sehen nur
// die Auth-Beschreibung (`module.Authenticated()`, `module.Verb(v)`, …), nie das Gate selbst.
type moduleRoutes struct {
	mux *http.ServeMux
	g   *authGate
}

func (m moduleRoutes) Handle(pattern string, a module.Auth, h http.HandlerFunc) {
	switch a.Kind {
	case module.AuthAnonymous:
		m.mux.HandleFunc(pattern, h)
	case module.AuthAuthenticated:
		m.mux.HandleFunc(pattern, m.g.requireAuth(h))
	case module.AuthVerbGlobal:
		m.mux.HandleFunc(pattern, m.g.requireVerbGlobal(a.Verb, h))
	case module.AuthVerbOnNode:
		m.mux.HandleFunc(pattern, m.g.requireVerbOnNode(a.Verb, h))
	default:
		// Unbekannte Rechtepflicht: sicherheitshalber wie "Admin" behandeln statt offen zu lassen.
		m.mux.HandleFunc(pattern, m.g.requireVerbGlobal(authz.VerbAdmin, h))
	}
}

// WithModules mountet die Module der Registry (nach den Kernrouten, vor dem Datei-Fallback).
func WithModules(reg *module.Registry, deps module.Deps) HandlerOption {
	return func(o *handlerOptions) { o.modules, o.moduleDeps, o.moduleHooks = reg, deps, deps.Hooks }
}

// handleModules: GET /api/v1/modules — Stand aller Module samt Oberfläche (Manifest für die Shell, Kapitel 36.3).
// Für jede angemeldete Person: die Shell braucht es vor der Anmeldung nicht, die Tabs der Module verlangen ohnehin
// ihre eigenen Rechte an den Routen.
func handleModules(reg *module.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if reg == nil {
			writeJSON(w, http.StatusOK, []module.Info{})
			return
		}
		writeJSON(w, http.StatusOK, reg.Info())
	}
}

// methodObserverTap umschließt den Methoden-Proxy: nach einem erfolgreichen Aufruf (Status < 300) werden die Beobachter der
// Module benachrichtigt (module.Hooks). Der Körper wird nur gelesen, wenn ein Beobachter den Methodennamen kennt; ein Beobachter
// kann den Aufruf nie beeinflussen.
func methodObserverTap(next http.HandlerFunc, hooks *module.Hooks, nodes NodeLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !hooks.WantsMethod(name) {
			next(w, r)
			return
		}
		var raw []byte
		if r.Body != nil {
			raw, _ = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if rec.status >= 300 {
			return
		}
		node, ok := nodes.Get(r.PathValue("id"))
		if !ok {
			return
		}
		hooks.NotifyMethod(module.MethodCall{NodeID: r.PathValue("id"), InstanceID: node.InstanceID, Name: name, Body: raw, Actor: actorFromRequest(r), Request: r})
	}
}

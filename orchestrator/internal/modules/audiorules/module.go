// Package audiorules ist das Modul „Audio-Ausgabe“ des Orchestrators (UMSETZUNG.md Kapitel 36.7): das plattformweite
// Dokument `audio-rules` (Ausgabegruppen, Spurschemata, Zuordnungsvorlagen, Ersatzregeln) mit Prüfung, Standardwerten und
// dem Test-Werkzeug `audio-sim`. Die Auflösung selbst passiert in den Nodes (Rust-Crate `omp-audio-rules`); der Orchestrator
// speichert und prüft nur die Struktur. Der Editor liegt als Admin-Untertab (Gruppe „Playout“) im eigenen UI-Bundle.
package audiorules

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// InstanceRoleResolver ordnet eine Launcher-Instanz ihrer Workflow-Rolle zu (*workflows.Service).
type InstanceRoleResolver interface {
	FindRoleForInstance(instanceID string) (workflowID, role string, ok bool)
}

// Services sind die Kerndienste, die das Modul braucht (vom Aufrufer in `main.go` gesetzt, vor dem Mounten der Routen).
type Services struct {
	// Roles: Workflow einer anfragenden Instanz (ein Player im Workflow bekommt die Regeln des Channels dieses Workflows).
	Roles InstanceRoleResolver
	// LabelOf: Label einer Instanz ("" = unbekannt); verbindet einen Player mit dem Channel, dessen Automation ihn als Ziel führt.
	LabelOf func(instanceID string) string
}

// Module ist das Audio-Ausgabe-Modul.
type Module struct{ svc *Services }

func New(svc *Services) *Module {
	if svc == nil {
		svc = &Services{}
	}
	return &Module{svc: svc}
}

func (*Module) Name() string { return "audio-rules" }

// Mount meldet die vier Routen an (Rechtepflicht je Route ausgeschrieben, damit auch das Routentabellen-Werkzeug sie liest).
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	ch := &channelRules{settings: d.Settings, db: d.DB, roles: m.svc.Roles, actor: d.Actor, labelOf: m.svc.LabelOf}
	r.Handle("GET /api/v1/audio-rules", module.Authenticated(), ch.handleGetEffective())
	r.Handle("GET /api/v1/audio-rules/channel/{id}", module.Authenticated(), ch.handleGetChannel())
	r.Handle("POST /api/v1/audio-rules/channel/{id}/targets", module.Authenticated(), ch.handlePostTargets())
	r.Handle("PUT /api/v1/audio-rules/channel/{id}", module.Verb(authz.VerbAdmin), ch.handlePutChannel())
	r.Handle("DELETE /api/v1/audio-rules/channel/{id}", module.Verb(authz.VerbAdmin), ch.handleDeleteChannel())
	r.Handle("GET /api/v1/audio-rules/default", module.Authenticated(), handleGetAudioRulesDefault())
	r.Handle("POST /api/v1/audio-rules/simulate", module.Authenticated(), handleSimulateAudioRules())
	r.Handle("PUT /api/v1/audio-rules", module.Verb(authz.VerbAdmin), handlePutAudioRules(d.Settings))
	return nil
}

// UI: Untertab „Audio-Ausgabe“ in der Admin-Gruppe „Playout“.
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "audio", Placement: "admin:playout",
		Group:   map[string]string{"de": "Playout", "en": "Playout"},
		Label:   map[string]string{"de": "Audio-Ausgabe", "en": "Audio output"},
		Element: "omp-audio-rules", Bundle: "/dist/modules/audio-rules.js",
	}}
}

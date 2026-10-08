// Package audiorules ist das Modul „Audio-Ausgabe“ des Orchestrators (UMSETZUNG.md Kapitel 36.7): das plattformweite
// Dokument `audio-rules` (Ausgabegruppen, Spurschemata, Zuordnungsvorlagen, Ersatzregeln) mit Prüfung, Standardwerten und
// dem Test-Werkzeug `audio-sim`. Die Auflösung selbst passiert in den Nodes (Rust-Crate `omp-audio-rules`); der Orchestrator
// speichert und prüft nur die Struktur. Der Editor liegt als Admin-Untertab (Gruppe „Playout“) im eigenen UI-Bundle.
package audiorules

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Module ist das Audio-Ausgabe-Modul.
type Module struct{}

func New() *Module { return &Module{} }

func (*Module) Name() string { return "audio-rules" }

// Mount meldet die vier Routen an (Rechtepflicht je Route ausgeschrieben, damit auch das Routentabellen-Werkzeug sie liest).
func (*Module) Mount(r module.Routes, d module.Deps) error {
	r.Handle("GET /api/v1/audio-rules", module.Authenticated(), handleGetAudioRules(d.Settings))
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

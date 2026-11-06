package radio

import (
	"context"
	"sync"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte des Moduls (Kapitel 44). Globales `configure` deckt alle ab.
const (
	FeatPrepare   = "radio.show.prepare"    // Sendungen und Vorlagen anlegen; eigene (als Besitzer/in oder Moderierende) bearbeiten
	FeatRelease   = "radio.show.release"    // freigeben, auf Sendung nehmen, abschließen
	FeatManageAll = "radio.show.manage_all" // auch fremde Sendungen bearbeiten und löschen
)

// Module ist das Radio-Modul.
type Module struct {
	mu sync.Mutex
	d  module.Deps
}

func New() *Module { return &Module{} }

func (*Module) Name() string { return "radio" }

func (*Module) Migrations() []module.Migration {
	return []module.Migration{{Version: 1, Name: "radio_shows", SQL: schema}}
}

func (m *Module) store() *Store {
	m.mu.Lock()
	defer m.mu.Unlock()
	return NewStore(m.d.DB)
}

func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "Radio", "en": "Radio"}
	f := func(id, de, en, dde, den string) module.FeatureDef {
		return module.FeatureDef{ID: id, Label: map[string]string{"de": de, "en": en}, Description: map[string]string{"de": dde, "en": den}, Group: g}
	}
	return []module.FeatureDef{
		f(FeatPrepare, "Sendungen vorbereiten", "Prepare shows", "Sendungen und Vorlagen anlegen und die eigenen (als Besitzer oder Moderierende) bearbeiten: Ablauf, Moderationskarten, Hotkeys, Notizen.", "Create shows and templates and edit your own (as owner or presenter): running order, presenter cards, hotkeys, notes."),
		f(FeatRelease, "Sendungen freigeben und auf Sendung nehmen", "Release shows and take them on air", "Eine vorbereitete Sendung freigeben, auf Sendung nehmen und abschließen.", "Release a prepared show, take it on air and finish it."),
		f(FeatManageAll, "Fremde Sendungen bearbeiten", "Manage others' shows", "Sendungen bearbeiten und löschen, die anderen gehören (zusätzlich zu den Rechten oben).", "Edit and delete shows that belong to others (in addition to the rights above)."),
	}
}

// Mount meldet die Routen an.
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	a := &api{m: m, access: d.Access, audit: d.Audit}
	r.Handle("GET /api/v1/radio/shows", module.Authenticated(), a.list())
	r.Handle("POST /api/v1/radio/shows", module.Feature(FeatPrepare), a.create())
	r.Handle("GET /api/v1/radio/shows/current", module.Authenticated(), a.current())
	r.Handle("GET /api/v1/radio/shows/{id}", module.Authenticated(), a.get())
	r.Handle("PUT /api/v1/radio/shows/{id}", module.Feature(FeatPrepare), a.update())
	r.Handle("DELETE /api/v1/radio/shows/{id}", module.Feature(FeatPrepare), a.delete())
	r.Handle("POST /api/v1/radio/shows/{id}/status", module.Feature(FeatPrepare, FeatRelease), a.setStatus())
	r.Handle("POST /api/v1/radio/shows/{id}/duplicate", module.Feature(FeatPrepare), a.duplicate())
	r.Handle("GET /api/v1/radio/shows/{id}/versions", module.Authenticated(), a.versions())
	r.Handle("GET /api/v1/radio/shows/{id}/versions/{version}", module.Authenticated(), a.version())
	r.Handle("POST /api/v1/radio/shows/{id}/versions/{version}/restore", module.Feature(FeatPrepare), a.restore())
	return nil
}

// Start: kein Hintergrundjob (reserviert für Erinnerungen und automatisches Laden zur Sendezeit).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	<-ctx.Done()
	return nil
}

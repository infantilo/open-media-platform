package radio

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

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
	return []module.Migration{{Version: 1, Name: "radio_shows", SQL: schema}, {Version: 2, Name: "radio_recurrence_autolive", SQL: schemaV2}}
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

// Start: Hintergrundlauf (nur auf dem Raft-Leader): Wiederkehr aus Vorlagen anlegen und den Status nach dem Zeitfenster schalten.
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	if d.DB == nil {
		<-ctx.Done()
		return nil
	}
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		func() {
			defer func() {
				if p := recover(); p != nil {
					slog.Error("radio: Hintergrundlauf abgestürzt", "panic", p)
				}
			}()
			m.Materialize(ctx)
			m.Transition(ctx, time.Now())
		}()
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

const schedulerActor = "radio-scheduler"

// Transition schaltet freigegebene Sendungen zum Beginn auf „live“ und laufende nach dem Ende auf „done“ (nur mit autoLive).
func (m *Module) Transition(ctx context.Context, now time.Time) {
	ch, err := m.store().AutoTransitions(ctx, now, schedulerActor)
	if err != nil {
		slog.Warn("radio: Statusschaltung fehlgeschlagen", "error", err)
		return
	}
	for _, c := range ch {
		if a := m.deps().Audit; a != nil {
			a.Log(schedulerActor, "radio_show", c[0], "status", map[string]any{"from": c[1], "to": c[2], "auto": true})
		}
	}
}

// Materialize legt für alle Vorlagen mit Wiederkehr die Sendungen der nächsten `horizonDays` Tage an (idempotent).
func (m *Module) Materialize(ctx context.Context) {
	st := m.store()
	tpls, err := st.RecurringTemplates(ctx)
	if err != nil {
		slog.Warn("radio: Vorlagen nicht lesbar", "error", err)
		return
	}
	now := time.Now()
	for _, t := range tpls {
		rec, err := ParseRecurrence(t.Recurrence)
		if err != nil || !rec.Enabled {
			continue
		}
		occ, err := rec.Occurrences(now, now.AddDate(0, 0, rec.HorizonDays))
		if err != nil {
			slog.Warn("radio: Termine nicht berechenbar", "template", t.ID, "error", err)
			continue
		}
		loc, _ := time.LoadLocation(rec.TZ)
		for _, o := range occ {
			title := fmt.Sprintf("%s %s", t.Title, o.Start.In(loc).Format("02.01."))
			created, err := st.CreateOccurrence(ctx, t, o, title, schedulerActor)
			if err != nil {
				slog.Warn("radio: Sendung aus Vorlage nicht angelegt", "template", t.ID, "error", err)
				continue
			}
			if created {
				if a := m.deps().Audit; a != nil {
					a.Log(schedulerActor, "radio_show", t.ID, "materialize", map[string]any{"title": title, "start": o.Start})
				}
			}
		}
	}
}

func (m *Module) deps() module.Deps {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.d
}

// Package playout ist das Playout-Modul des Orchestrators (ARCHITECTURE.md §28, UMSETZUNG.md Kapitel 36.8): Channels (mit
// Zustand und Ausführungsjournal), Channel-Trigger samt Regeln, As-Run-Protokoll (inkl. Mitschnitt manueller Eingriffe und
// Prometheus-Kennzahlen) sowie Medien-Preflight/Materialisierung. Dazu das Wissen über die Playout-Automation für den
// Workflow-Dienst (automation.go). Das Modul legt seine Stores selbst an; vom Kern bekommt es nur schmale Dienste (`Services`).
package playout

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/channeltrigger"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

// Services sind die Kerndienste, die das Modul braucht (vom Aufrufer in `main.go` gesetzt).
type Services struct {
	// Authz prüft globale Rechte (Operator-Zugriff auf einen Channel).
	Authz verbChecker
	// Roles ordnet eine Instanz ihrer Workflow-Rolle zu (der Channel hängt an der Rolle, nicht an der flüchtigen Instanz-ID).
	Roles InstanceRoleResolver
	// Preflight (Medienverfügbarkeit/Bereitstellung); nil schaltet die beiden Routen ab.
	Preflight PreflightService
	// Launcher/NodeValues: Ziel-Player und Medienverzeichnis des Preflights.
	Launcher   LauncherService
	NodeValues NodeOptionValues
	// Nodes: Auskunft Node → Instanz für den Mitschnitt manueller Eingriffe.
	Nodes NodeLister
	// Publisher zustellt Trigger per NATS; nil = Trigger werden nur gespeichert.
	Publisher channeltrigger.Publisher
	// RetentionDays: Aufbewahrung des As-Run-Protokolls.
	RetentionDays int
}

// Module ist das Playout-Modul.
type Module struct {
	svc *Services

	store   *playout.Store // konkreter Store (Router und Handler greifen über Schnittstellen zu)
	playout PlayoutService
	trigger *channeltrigger.Store
	router  *channeltrigger.Router
	asrun   AsRunStore
	asrunDB *asrun.Store
	metrics *asrun.Metrics
}

// New legt das Modul an; die Stores entstehen in Mount (dort ist die Datenbank bekannt).
// svc darf nach New noch befüllt werden, solange es vor `Mount` geschieht (die Dienste entstehen in `main.go` erst später).
func New(svc *Services) *Module { return &Module{svc: svc} }

func (*Module) Name() string { return "playout" }

func (m *Module) Mount(r module.Routes, d module.Deps) error {
	m.store = playout.NewStore(d.DB)
	m.playout = m.store
	m.trigger = channeltrigger.NewStore(d.DB)
	m.metrics = asrun.NewMetrics()
	m.asrunDB = asrun.NewStore(d.DB, m.metrics)
	m.asrun = m.asrunDB
	m.router = &channeltrigger.Router{
		OnApplied: m.metrics.ObserveTriggerLatency,
		Store:     m.trigger, Channels: m.store,
		Audit: func(actor, id, action string, details map[string]any) {
			if d.Audit != nil {
				d.Audit.Log(actor, "channel_trigger", id, action, details)
			}
		},
	}
	if m.svc.Publisher != nil {
		m.router.Pub = m.svc.Publisher
	}
	svc, az, roles, audit := m.playout, m.svc.Authz, m.svc.Roles, d.Audit

	// Rechtepflicht je Route ausgeschrieben (nicht über Variablen): so liest sie auch das Routentabellen-Werkzeug.
	r.Handle("GET /api/v1/playout/channels", module.Authenticated(), handleListPlayoutChannels(svc, roles))
	r.Handle("POST /api/v1/playout/channels", module.Verb(authz.VerbConfigure), handleCreatePlayoutChannel(svc, audit))
	r.Handle("GET /api/v1/playout/channels/{id}", module.Authenticated(), handleGetPlayoutChannel(svc))
	r.Handle("PUT /api/v1/playout/channels/{id}", module.Verb(authz.VerbConfigure), handleUpdatePlayoutChannel(svc, audit))
	r.Handle("DELETE /api/v1/playout/channels/{id}", module.Verb(authz.VerbConfigure), handleDeletePlayoutChannel(svc, audit))
	r.Handle("GET /api/v1/playout/channels/{id}/state", module.Authenticated(), handleGetPlayoutState(svc, az, roles))
	r.Handle("PUT /api/v1/playout/channels/{id}/state", module.Authenticated(), handlePutPlayoutState(svc, az, roles))
	r.Handle("POST /api/v1/playout/channels/{id}/executions", module.Authenticated(), handleRecordPlayoutExecution(svc, az, roles))
	if m.svc.Preflight != nil {
		r.Handle("POST /api/v1/playout/channels/{id}/preflight", module.Authenticated(), handlePlayoutPreflight(m.svc.Preflight, svc, az, roles, m.svc.Launcher, m.svc.NodeValues))
		r.Handle("POST /api/v1/playout/channels/{id}/materialize", module.Authenticated(), handlePlayoutMaterialize(m.svc.Preflight, svc, az, roles, m.svc.Launcher, m.svc.NodeValues, audit))
	}
	r.Handle("POST /api/v1/playout/channels/{id}/as-run", module.Authenticated(), handlePostAsRun(m.asrun, svc, az, roles))
	r.Handle("GET /api/v1/playout/channels/{id}/as-run", module.Verb(authz.VerbView), handleGetAsRun(m.asrun, svc))
	r.Handle("POST /api/v1/playout/channels/{id}/triggers", module.Authenticated(), handleSendChannelTrigger(m.router, svc, az, roles))
	r.Handle("POST /api/v1/playout/channels/{id}/trigger-ack", module.Authenticated(), handleAckChannelTrigger(m.router, svc, az, roles))
	r.Handle("GET /api/v1/playout/triggers", module.Verb(authz.VerbView), handleListChannelTriggers(m.trigger))
	r.Handle("GET /api/v1/playout/trigger-rules", module.Verb(authz.VerbView), handleListTriggerRules(m.trigger))
	r.Handle("POST /api/v1/playout/trigger-rules", module.Verb(authz.VerbConfigure), handleAddTriggerRule(m.trigger, audit))
	r.Handle("DELETE /api/v1/playout/trigger-rules/{id}", module.Verb(authz.VerbConfigure), handleDeleteTriggerRule(m.trigger, audit))

	// Manuelle Eingriffe an Automator-Nodes werden im As-Run festgehalten (Spec §119).
	if d.Hooks != nil {
		names := make([]string, 0, len(operatorActions))
		for n := range operatorActions {
			names = append(names, n)
		}
		d.Hooks.OnNodeMethod(names, m.operatorObserver(d.Audit))
	}
	return nil
}

// Start: Trigger-Zustellung samt Wiederholung und die tägliche As-Run-Bereinigung — der Kern ruft das nur auf dem Raft-Leader.
func (m *Module) Start(ctx context.Context, _ module.Deps) error {
	go m.router.Run(ctx)
	retention := m.svc.RetentionDays
	if retention <= 0 {
		retention = 90
	}
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		if n, err := m.asrunDB.Prune(ctx, time.Now().AddDate(0, 0, -retention)); err != nil {
			slog.Warn("as-run: Bereinigung fehlgeschlagen", "error", err)
		} else if n > 0 {
			slog.Info("as-run: alte Einträge gelöscht", "count", n)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// WriteMetrics: die As-Run-/Trigger-Kennzahlen für `GET /metrics`.
func (m *Module) WriteMetrics(w io.Writer) {
	if m.metrics != nil {
		var b strings.Builder
		m.metrics.WritePrometheus(&b)
		_, _ = io.WriteString(w, b.String())
	}
}

// UI: Untertab „Channels & Trigger“ in der Admin-Gruppe „Playout“ (Bundle kommt mit dem UI-Umzug).
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "channels", Placement: "admin:playout",
		Group:   map[string]string{"de": "Playout", "en": "Playout"},
		Label:   map[string]string{"de": "Channels & Trigger", "en": "Channels & triggers"},
		Element: "omp-playout-admin", Bundle: "/dist/modules/playout.js",
	}}
}

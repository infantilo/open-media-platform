// Package mcr ist das Modul „Hauptkontrollraum“ des Orchestrators (UMSETZUNG.md Kapitel 106.9, ARCHITECTURE.md §33): Events mit
// Leitungen, Vorlagen, Rollen je Event und Lebenszyklus. Die Datenbank ist die Quelle der Wahrheit; Nodes bekommen ihre
// Startumgebung daraus (106.10). **Geheimnisse (Passphrasen) werden nie gespeichert**, nur ihr Schlüsselname.
package mcr

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte des Moduls. Globales `configure` deckt alle ab.
const (
	FeatManage = "mcr.manage" // Events, Vorlagen und Leitungen anlegen und ändern
	FeatLive   = "mcr.live"   // Zustand wechseln (testing → live → …)
)

type Module struct {
	svc *Service
	rt  *Runtime

	namesMu sync.Mutex
	names   map[string]string // "<Workflow>|<Rolle>" → Quellname
	namesAt time.Time
}

func New() *Module { return &Module{} }

// SetRuntime bindet Workflow-Dienst und Nodes an (von `main.go`, vor dem Mounten der Routen).
func (m *Module) SetRuntime(rt *Runtime) { m.rt = rt }

func (*Module) Name() string { return "mcr" }

func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "Hauptkontrollraum", "en": "Master control room"}
	return []module.FeatureDef{
		{ID: FeatManage, Label: map[string]string{"de": "Events und Leitungen verwalten", "en": "Manage events and lines"}, Group: g,
			Description: map[string]string{"de": "Events, Vorlagen und Leitungen anlegen, ändern und löschen.", "en": "Create, change and delete events, templates and lines."}},
		{ID: FeatView, Label: map[string]string{"de": "Alle Events ansehen", "en": "See all events"}, Group: g,
			Description: map[string]string{"de": "Alle Events, Überwachung und Alarme ansehen (nur lesen). Ohne dieses Recht sieht die Person nur Events, in denen sie Mitglied oder verantwortlich ist.", "en": "See all events, monitoring and alarms (read only). Without it the person only sees events they are a member of or responsible for."}},
		{ID: FeatLive, Label: map[string]string{"de": "Event bedienen", "en": "Operate event"}, Group: g,
			Description: map[string]string{"de": "Ein Event in Test, auf Sendung und in den Abbau schalten sowie den A/V-Versatz der Leitungen messen und übernehmen (Bedienansicht).", "en": "Move an event to test, live and teardown and measure and apply the A/V offset of its lines (operator view)."}},
	}
}

func (m *Module) Mount(r module.Routes, d module.Deps) error {
	m.svc = &Service{St: NewStore(d.DB), Settings: d.Settings, Audit: d.Audit, Run: m.rt}
	a := &api{svc: m.svc, access: d.Access}
	r.Handle("GET /api/v1/mcr/templates", module.Authenticated(), a.listTemplates())
	r.Handle("POST /api/v1/mcr/templates", module.Feature(FeatManage), a.createTemplate())
	r.Handle("PUT /api/v1/mcr/templates/{id}", module.Feature(FeatManage), a.updateTemplate())
	r.Handle("DELETE /api/v1/mcr/templates/{id}", module.Feature(FeatManage), a.deleteTemplate())
	r.Handle("GET /api/v1/mcr/events", module.Authenticated(), a.listEvents())
	r.Handle("POST /api/v1/mcr/events", module.Feature(FeatManage), a.createEvent())
	r.Handle("GET /api/v1/mcr/events/{id}", module.Authenticated(), a.getEvent())
	r.Handle("PUT /api/v1/mcr/events/{id}", module.Authenticated(), a.updateEvent())
	r.Handle("DELETE /api/v1/mcr/events/{id}", module.Authenticated(), a.deleteEvent())
	r.Handle("POST /api/v1/mcr/events/{id}/transition", module.Authenticated(), a.transition())
	r.Handle("PUT /api/v1/mcr/events/{id}/members", module.Feature(FeatManage), a.putMembers())
	r.Handle("GET /api/v1/mcr/events/{id}/alarms", module.Authenticated(), a.eventAlarms())
	r.Handle("POST /api/v1/mcr/events/{id}/alarms/{alarmId}/ack", module.Authenticated(), a.ackAlarm())
	r.Handle("POST /api/v1/mcr/events/{id}/alarm-pip", module.Authenticated(), a.pipLock())
	r.Handle("GET /api/v1/mcr/alarms/history", module.Authenticated(), a.alarmHistory())
	r.Handle("GET /api/v1/mcr/monitor", module.Authenticated(), a.wall())
	r.Handle("POST /api/v1/mcr/events/{id}/lines/{lineId}/monitor", module.Authenticated(), a.station())
	r.Handle("GET /api/v1/mcr/events/{id}/precheck", module.Authenticated(), a.precheck())
	r.Handle("GET /api/v1/mcr/events/{id}/status", module.Authenticated(), a.status())
	r.Handle("POST /api/v1/mcr/events/{id}/lines/{lineId}/measure", module.Authenticated(), a.measure())
	r.Handle("PUT /api/v1/mcr/events/{id}/lines/{lineId}/avsync", module.Authenticated(), a.putAvsync())
	// Beobachter: Übernimmt der Bediener einen Messwert am Node (`avsync.apply`), geht er auch in die Datenbank
	// (Quelle der Wahrheit), sonst wäre er nach Stop/Start weg.
	if d.Hooks != nil && m.rt != nil {
		d.Hooks.OnNodeMethod([]string{"avsync.apply", "avsync.reset"}, m.onAvsyncMethod)
	}
	r.Handle("GET /api/v1/mcr/settings", module.Authenticated(), a.getSettings())
	r.Handle("PUT /api/v1/mcr/settings", module.Verb(authz.VerbAdmin), a.putSettings())
	return nil
}

// WatchAlarms hört den Alarmbus ab und führt die Alarmhistorie (nur auf dem Leader aufrufen).
func (m *Module) WatchAlarms(ctx context.Context, hub Subscriber) {
	if m.rt == nil || m.svc == nil {
		return
	}
	m.rt.WatchAlarms(ctx, m.svc, hub)
}

// Start: regelmäßiger Abgleich der laufenden Events (nur auf dem Raft-Leader).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	if m.rt == nil || m.svc == nil {
		return nil
	}
	go m.rt.ReconcileLoop(ctx, m.svc, 3*time.Second)
	return nil
}

func (m *Module) onAvsyncMethod(c module.MethodCall) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	evs, err := m.svc.St.ActiveEvents(ctx)
	if err != nil {
		return
	}
	for _, e := range evs {
		_, roles, err := m.rt.definitionFor(m.svc, e)
		if err != nil || e.WorkflowID == "" {
			continue
		}
		wf, err := m.rt.Wf.Get(e.WorkflowID)
		if err != nil {
			continue
		}
		for _, l := range e.Lines {
			rr, ok := wf.Runtime[roles[l.ID].Normalizer]
			if !ok || rr.InstanceID != c.InstanceID {
				continue
			}
			if c.Name == "avsync.reset" {
				// gehaltenen Wert löschen
				mm := map[string]any{}
				_ = json.Unmarshal(l.Avsync, &mm)
				delete(mm, "heldMs")
				b, _ := json.Marshal(mm)
				_ = m.svc.St.SetLineAvsync(ctx, e.ID, l.ID, b)
				return
			}
			v, err := m.rt.ReadParam(ctx, c.InstanceID, "avsync.heldMs")
			if f, ok := v.(float64); ok && err == nil {
				if err := m.svc.StoreAppliedAvsync(ctx, e.ID, l.ID, f); err != nil {
					slog.Warn("mcr: übernommenen Messwert nicht gespeichert", "event", e.ID, "error", err)
				}
			}
			return
		}
	}
}

// RoleEnvHook ergänzt beim Start jeder Rolle eines MCR-Workflows die Umgebung aus der **Datenbank** (Hausformat, Eingangseinstellungen,
// Dateipfad der Passphrase). Er läuft im Workflow-Dienst (`RegisterRoleEnvHook`); für fremde Workflows liefert er nichts.
func (m *Module) RoleEnvHook(def workflows.Definition, role workflows.Role) map[string]string {
	if env := MonitorEnv(def, role); env != nil {
		return env
	}
	if m.svc == nil || m.rt == nil || !strings.HasPrefix(def.Description, DescriptionPrefix) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, err := m.svc.St.GetEvent(ctx, strings.TrimPrefix(def.Description, DescriptionPrefix))
	if err != nil {
		slog.Warn("mcr: Startumgebung: Event nicht lesbar", "error", err)
		return nil
	}
	g, _ := m.svc.GlobalHouse()
	_, _, envs, err := Materialize(e, g, m.rt.secrets(), m.svc.ChainConfig())
	if err != nil {
		slog.Warn("mcr: Startumgebung", "event", e.ID, "error", err)
		return nil
	}
	return envs[role.Name]
}

// UI: Tab „Hauptkontrollraum“ in der Hauptleiste (Arbeitsplatz mit Eventliste, Leitungskarten, Vorlagen, Hausformat).
// Tiles: Kachel für die Bedienansicht (Arbeitsplatz) – erscheint für jede Person mit einem MCR-Recht, z. B. in der Gruppe „hkr“.
func (*Module) Tiles() []module.UITile {
	return []module.UITile{{
		ID: "control-room", Label: map[string]string{"de": "Hauptkontrollraum", "en": "Master control room"},
		Needs:   []string{"mcr.*"},
		Element: "omp-mcr-view", Bundle: "/dist/modules/mcr.js",
	}}
}

func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "mcr", Placement: "main", After: "ingest",
		Label:   map[string]string{"de": "MCR", "en": "MCR"},
		Element: "omp-mcr-view", Bundle: "/dist/modules/mcr.js",
	}}
}

// SourceName liefert für den Normalizer einer Leitung den Quellnamen „MCR/<Event>/<Leitung>“, unter dem er in allen
// Quellenauswahlen (X/Y-Panel, Mischer, Playout …) erscheint. Gesucht wird unter den laufenden Events (kurz zwischengespeichert).
func (m *Module) SourceName(workflowID, role string) (string, bool) {
	if m.svc == nil || workflowID == "" {
		return "", false
	}
	m.namesMu.Lock()
	defer m.namesMu.Unlock()
	if m.names == nil || time.Since(m.namesAt) > 3*time.Second {
		names := map[string]string{}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		for _, st := range []string{StateTesting, StateLive, StateTeardown} {
			evs, err := m.svc.St.ListEvents(ctx, st)
			if err != nil {
				continue
			}
			for _, e := range evs {
				if e.WorkflowID == "" {
					continue
				}
				full, err := m.svc.St.GetEvent(ctx, e.ID)
				if err != nil {
					continue
				}
				for r, n := range SourceNames(full, m.svc.ChainConfig()) {
					names[full.WorkflowID+"|"+r] = n
				}
			}
		}
		m.names, m.namesAt = names, time.Now()
	}
	n, ok := m.names[workflowID+"|"+role]
	return n, ok
}

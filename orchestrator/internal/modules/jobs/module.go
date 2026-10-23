// Package jobs ist das Modul „ffmpeg-Jobs“ (UMSETZUNG.md Kapitel 52, docs/ENTWURF-FFMPEG-HOSTWAHL.md): Anbindung des
// Dispatchers (internal/jobrun) an den Orchestrator-Kern — Konfiguration, Routen, Verlauf, Oberfläche, Metriken. Aufrufer
// (script-Schritt, File-QC, Review-Proxy, Ingest-Convert) reichen ihre Jobs über [Module.Dispatcher] ein.
package jobs

import (
	"context"
	"io"
	"log/slog"
	"os/exec"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Module ist das Job-Modul.
type Module struct {
	disp *jobrun.Dispatcher
	// History: Telemetrie-Verlauf der Hosts (Live-Bedarf für die Auto-Kalibrierung); Profiles: typische Last je Node-Typ und Host.
	// Beide optional, von main.go gesetzt.
	History  *hosts.History
	Profiles ProfileLister

	mu    sync.Mutex
	d     module.Deps
	cfg   jobrun.Config
	cfgAt time.Time
	cfgOK bool
	tools map[string]string
}

// New legt Modul und Dispatcher an. Der Dispatcher ist sofort nutzbar (Aufrufer werden vor dem Mounten verdrahtet); Hosts und
// Einstellungen kommen mit Mount, die Verarbeitung beginnt mit Start (nur auf dem Raft-Leader).
func New() *Module {
	m := &Module{tools: map[string]string{}}
	for _, t := range []string{"ffmpeg", "ffprobe"} {
		if p, err := exec.LookPath(t); err == nil {
			m.tools[t] = p
		} else {
			slog.Warn("jobs: Programm auf dem Orchestrator-Rechner nicht gefunden", "tool", t)
		}
	}
	m.disp = jobrun.New(m.Config, hostSource{m: m})
	m.disp.Demand = func(hostID string, window time.Duration) (hosts.LiveDemand, bool) {
		if m.History == nil {
			return hosts.LiveDemand{}, false
		}
		return m.History.LiveDemand(hostID, window)
	}
	m.disp.LocalTool = m.LocalTool
	return m
}

func (*Module) Name() string { return "jobs" }

// Dispatcher ist der Einstiegspunkt für Aufrufer.
func (m *Module) Dispatcher() *jobrun.Dispatcher { return m.disp }

// LocalTool liefert den Programmpfad auf dem Orchestrator-Rechner ("" = nicht vorhanden).
func (m *Module) LocalTool(name string) string { return m.tools[name] }

func (m *Module) deps() module.Deps {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.d
}

// Config liefert das Einstellungsdokument (5 s zwischengespeichert; ungültig → Standardwerte).
func (m *Module) Config() jobrun.Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfgOK && time.Since(m.cfgAt) < 5*time.Second {
		return m.cfg
	}
	var raw []byte
	if m.d.Settings != nil {
		raw, _ = m.d.Settings.Get(jobrun.SettingsKey)
	}
	c, err := jobrun.ParseConfig(raw)
	if err != nil {
		slog.Warn("jobs: Konfiguration ungültig, Standardwerte aktiv", "error", err)
		c = jobrun.DefaultConfig()
	}
	m.cfg, m.cfgAt, m.cfgOK = c, time.Now(), true
	return c
}

func (m *Module) invalidate() {
	m.mu.Lock()
	m.cfgOK = false
	m.mu.Unlock()
}

func (*Module) Migrations() []module.Migration {
	return []module.Migration{{Version: 1, Name: "jobrun_jobs", SQL: schema}}
}

// Start: Verlauf laden, Dispatcher betreiben (nur auf dem Leader; mit dem Verlust der Führung endet auch die Schleife).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	if d.DB != nil {
		st := store{db: d.DB}
		m.disp.Store = st
		m.disp.Preload(st.restore())
	}
	m.disp.Loop(ctx)
	return nil
}

func (m *Module) WriteMetrics(w io.Writer) { m.disp.WriteMetrics(w) }

func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "jobs", Placement: "admin:platform", After: "storage",
		Label: map[string]string{"de": "ffmpeg-Jobs", "en": "ffmpeg jobs"},
		Group: map[string]string{"de": "Plattform", "en": "Platform"}, Cluster: "operations",
		Element: "omp-jobs-view", Bundle: "/dist/modules/jobs.js",
	}}
}

func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "ffmpeg-Jobs", "en": "ffmpeg jobs"}
	return []module.FeatureDef{
		{ID: "jobs.view", Group: g, Label: map[string]string{"de": "Jobs ansehen", "en": "View jobs"}, Description: map[string]string{"de": "Laufende, wartende und beendete ffmpeg-Jobs und die Host-Auslastung sehen.", "en": "See running, waiting and finished ffmpeg jobs and host load."}},
		{ID: "jobs.run", Group: g, Label: map[string]string{"de": "Jobs starten und abbrechen", "en": "Start and cancel jobs"}, Description: map[string]string{"de": "Eigene ffmpeg-Jobs einreihen und Jobs abbrechen.", "en": "Submit own ffmpeg jobs and cancel jobs."}},
		{ID: "jobs.configure", Group: g, Label: map[string]string{"de": "Job-Verteilung einstellen", "en": "Configure job placement"}, Description: map[string]string{"de": "Ziele, Gewichte, Live-Reserve, Sendeschutz und Hosts einstellen.", "en": "Configure targets, weights, live reserve, broadcast protection and hosts."}},
	}
}

// BusyFromBookings liefert eine Busy-Funktion für den Dispatcher aus einer Buchungsquelle (Ingest-Planer).
func BusyFromBookings(f func(hostID string, from, to time.Time) (bool, string)) func(string, time.Duration) (bool, string) {
	return func(hostID string, within time.Duration) (bool, string) {
		now := time.Now()
		return f(hostID, now, now.Add(within))
	}
}

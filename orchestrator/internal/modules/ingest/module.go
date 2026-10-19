// Package ingest ist das Modul „Aufnahme“ (UMSETZUNG.md Kapitel 42): geplante Live-Aufnahmen mit Zeitzone/Wiederholung, ressourcenbewusster
// Zulassung (Zeitfenster-Reservierung je Ressourcenart), Ablauf mit Wiederanlauf nach Neustart und Anbindung an Asset-Domäne und Eingang (Kapitel 43).
package ingest

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

const settingsKey = "ingest.config"

// Services: die vom Kern bereitgestellten Bausteine (main.go füllt sie, nachdem alle Dienste existieren).
type Services struct {
	Assets   *asset.Store
	Launcher LauncherAPI
	Nodes    NodeLister
	Graph    Connector
	Runtime  Runtime // optional: ersetzt LauncherRuntime (Tests)
	FFmpeg   string
}

type Module struct {
	S Services

	mu  sync.Mutex
	svc *Service
	cfg cfgHolder
}

func New(s Services) *Module { return &Module{S: s} }

func (*Module) Name() string { return "ingest" }

type cfgHolder struct {
	mu     sync.Mutex
	get    func() ([]byte, error)
	cached Config
	at     time.Time
	ok     bool
}

func (h *cfgHolder) Get() Config {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ok && time.Since(h.at) < 5*time.Second {
		return h.cached
	}
	var raw []byte
	if h.get != nil {
		raw, _ = h.get()
	}
	c, err := ParseConfig(raw)
	if err != nil {
		slog.Warn("ingest: Konfiguration ungültig, Standardwerte aktiv", "error", err)
		c = DefaultConfig()
	}
	h.cached, h.at, h.ok = c, time.Now(), true
	return c
}

func (h *cfgHolder) Invalidate() { h.mu.Lock(); h.ok = false; h.mu.Unlock() }

func (m *Module) service(d module.Deps) *Service {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.svc != nil {
		return m.svc
	}
	if m.S.Assets == nil {
		m.S.Assets = asset.NewStore(d.DB)
	}
	m.cfg.get = func() ([]byte, error) {
		if d.Settings == nil {
			return nil, nil
		}
		b, err := d.Settings.Get(settingsKey)
		if err == module.ErrNotFound {
			return nil, nil
		}
		return b, err
	}
	rt := m.S.Runtime
	if rt == nil && m.S.Launcher != nil {
		rt = &LauncherRuntime{Launcher: m.S.Launcher, Nodes: m.S.Nodes, Graph: m.S.Graph}
	}
	if rt == nil {
		rt = unavailableRuntime{}
	}
	s := &Service{St: NewStore(d.DB), Cfg: m.cfg.Get, Runtime: rt, Assets: m.S.Assets, Audit: d.Audit, FFmpeg: m.S.FFmpeg}
	s.Hosts = func(ctx context.Context) []HostInfo { return hostInfos(ctx, d, s.Cfg().MediaDir) }
	s.ChannelCount = m.channelCount
	m.svc = s
	return s
}

// unavailableRuntime: ohne Launcher (z. B. abgespeckter Start) lässt sich zwar planen, aber nicht aufnehmen — der Fehler ist sichtbar.
type unavailableRuntime struct{}

var errNoRuntime = fmt.Errorf("keine Laufzeit angebunden (Launcher fehlt)")

func (unavailableRuntime) Prepare(context.Context, string, string, string, string, int) (Session, error) {
	return Session{}, errNoRuntime
}
func (unavailableRuntime) Adopt(context.Context, string) (Session, bool) { return Session{}, false }
func (unavailableRuntime) ResolveSource(context.Context, Source) error   { return errNoRuntime }
func (unavailableRuntime) Connect(context.Context, Session, Source, *AudioPlan) error {
	return errNoRuntime
}
func (unavailableRuntime) StartRecording(context.Context, Session, string, string, *AudioPlan) error {
	return errNoRuntime
}
func (unavailableRuntime) Status(context.Context, Session) (string, int64, error) {
	return "", 0, errNoRuntime
}
func (unavailableRuntime) StopRecording(context.Context, Session) error { return nil }
func (unavailableRuntime) Teardown(context.Context, string) error       { return nil }
func (unavailableRuntime) Instances(context.Context) []string           { return nil }

// hostInfos: lokaler Host + registrierte Host-Agents mit zuletzt gemeldeter Telemetrie.
func hostInfos(ctx context.Context, d module.Deps, mediaDir string) []HostInfo {
	local := HostInfo{ID: "local", Label: "Orchestrator-Host", Online: true, CPUCores: float64(runtime.NumCPU())}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "MemTotal:") {
				var kb float64
				fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(l, "MemTotal:")), "%f", &kb)
				local.MemTotalMB = kb / 1024
			}
		}
	}
	local.DiskFreeGB = diskFreeGB(mediaDir)
	out := []HostInfo{local}
	if d.Hosts != nil {
		if hs, err := d.Hosts.ListHosts(); err == nil {
			for _, h := range hs {
				hi := HostInfo{ID: h.ID, Label: h.Label, Maintenance: h.MaintenanceSince != nil}
				if hi.Label == "" {
					hi.Label = h.Hostname
				}
				if d.HostMetrics != nil {
					if m, ok := d.HostMetrics.Get(h.ID); ok && time.Since(m.ReceivedAt) < 30*time.Second && !m.Goodbye {
						hi.Online = true
						hi.MemTotalMB = float64(m.MemTotalBytes) / 1048576
					}
				}
				out = append(out, hi)
			}
		}
	}
	return out
}

func diskFreeGB(dir string) float64 {
	var st syscall.Statfs_t
	if dir == "" {
		dir = "."
	}
	if syscall.Statfs(dir, &st) != nil {
		return 0
	}
	return float64(st.Bavail) * float64(st.Bsize) / 1e9
}

func (m *Module) Mount(r module.Routes, d module.Deps) error {
	svc := m.service(d)
	a := &api{svc: svc, m: m, settings: d.Settings, nodes: m.S.Nodes, access: d.Access}
	r.Handle("GET /api/v1/ingest/schedules", module.Authenticated(), a.listSchedules())
	r.Handle("POST /api/v1/ingest/schedules", module.Feature("ingest.schedule.create"), a.createSchedule())
	r.Handle("GET /api/v1/ingest/schedules/{id}", module.Authenticated(), a.getSchedule())
	r.Handle("PUT /api/v1/ingest/schedules/{id}", module.Feature("ingest.schedule.edit"), a.updateSchedule())
	r.Handle("DELETE /api/v1/ingest/schedules/{id}", module.Feature("ingest.schedule.edit"), a.deleteSchedule())
	r.Handle("GET /api/v1/ingest/schedules/{id}/preview", module.Authenticated(), a.previewSchedule())
	r.Handle("GET /api/v1/ingest/jobs", module.Authenticated(), a.listJobs())
	r.Handle("GET /api/v1/ingest/jobs/{id}", module.Authenticated(), a.getJob())
	r.Handle("POST /api/v1/ingest/jobs/{id}/cancel", module.Feature("ingest.job.control"), a.cancelJob())
	r.Handle("POST /api/v1/ingest/jobs/{id}/reschedule", module.Feature("ingest.job.control"), a.rescheduleJob())
	r.Handle("POST /api/v1/ingest/jobs/{id}/readmit", module.Feature("ingest.job.control"), a.readmit())
	r.Handle("POST /api/v1/ingest/adhoc", module.Feature("ingest.adhoc.create"), a.adhoc())
	r.Handle("POST /api/v1/ingest/plan", module.Authenticated(), a.plan())
	r.Handle("GET /api/v1/ingest/capacity", module.Authenticated(), a.capacity())
	r.Handle("GET /api/v1/ingest/sources", module.Authenticated(), a.sources())
	r.Handle("GET /api/v1/ingest/config", module.Authenticated(), a.getConfig())
	r.Handle("PUT /api/v1/ingest/config", module.Verb(authz.VerbAdmin), a.putConfig())
	return nil
}

// UI: Tab „Aufnahmen“ nach dem Scheduler.
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "ingest", Placement: "main", After: "scheduler",
		Label:   map[string]string{"de": "Aufnahmen", "en": "Recordings"},
		Element: "omp-ingest-view", Bundle: "/dist/modules/ingest.js",
	}}
}

// Start: Hintergrundarbeit (nur auf dem Raft-Leader, endet mit ctx).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	svc := m.service(d)
	go func() {
		svc.Reconcile(ctx)
		svc.MaterializeAll(ctx)
		tick := time.NewTicker(time.Second)
		mat := time.NewTicker(15 * time.Second)
		rec := time.NewTicker(60 * time.Second)
		defer tick.Stop()
		defer mat.Stop()
		defer rec.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				svc.Tick(ctx)
			case <-mat.C:
				svc.MaterializeAll(ctx)
			case <-rec.C:
				svc.Reconcile(ctx)
			}
		}
	}()
	return nil
}

// WriteMetrics: Kennzahlen für GET /metrics.
func (m *Module) WriteMetrics(w io.Writer) {
	m.mu.Lock()
	svc := m.svc
	m.mu.Unlock()
	if svc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, err := svc.St.db.QueryContext(ctx, `SELECT state, COUNT(*) FROM ingest_jobs GROUP BY state`)
	if err == nil {
		fmt.Fprintf(w, "# HELP omp_ingest_jobs Aufnahmeaufträge je Zustand\n# TYPE omp_ingest_jobs gauge\n")
		for rows.Next() {
			var k string
			var n int64
			if rows.Scan(&k, &n) == nil {
				fmt.Fprintf(w, "omp_ingest_jobs{state=%q} %d\n", k, n)
			}
		}
		rows.Close()
	}
	var queue, overdue int64
	_ = svc.St.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ingest_jobs WHERE state IN ('scheduled','blocked','waiting_for_resources')`).Scan(&queue)
	_ = svc.St.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ingest_jobs WHERE state IN ('scheduled','waiting_for_resources') AND planned_start < now()`).Scan(&overdue)
	var active, held float64
	_ = svc.St.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ingest_jobs WHERE state IN ('starting','recording')`).Scan(&active)
	_ = svc.St.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ingest_reservations WHERE state <> 'released'`).Scan(&held)
	fmt.Fprintf(w, "# HELP omp_ingest_queue_depth Wartende Aufträge (geplant/blockiert/wartend)\n# TYPE omp_ingest_queue_depth gauge\nomp_ingest_queue_depth %d\n", queue)
	fmt.Fprintf(w, "# HELP omp_ingest_overdue Aufträge, deren Startzeit verstrichen ist, ohne dass sie laufen\n# TYPE omp_ingest_overdue gauge\nomp_ingest_overdue %d\n", overdue)
	fmt.Fprintf(w, "# HELP omp_ingest_active_recorders Laufende/vorbereitete Rekorder\n# TYPE omp_ingest_active_recorders gauge\nomp_ingest_active_recorders %.0f\n", active)
	fmt.Fprintf(w, "# HELP omp_ingest_reservations Offene Ressourcenreservierungen\n# TYPE omp_ingest_reservations gauge\nomp_ingest_reservations %.0f\n", held)
	fmt.Fprintf(w, "# HELP omp_ingest_started_total Gestartete Aufnahmen seit Prozessstart\n# TYPE omp_ingest_started_total counter\nomp_ingest_started_total %d\n", metrics.Started.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_completed_total Abgeschlossene Aufnahmen\n# TYPE omp_ingest_completed_total counter\nomp_ingest_completed_total %d\n", metrics.Completed.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_failed_total Fehlgeschlagene Aufnahmen\n# TYPE omp_ingest_failed_total counter\nomp_ingest_failed_total %d\n", metrics.Failed.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_retries_total Wiederholte Aufnahmeversuche\n# TYPE omp_ingest_retries_total counter\nomp_ingest_retries_total %d\n", metrics.Retries.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_start_deviation_ms_sum Summe der Startabweichungen\n# TYPE omp_ingest_start_deviation_ms_sum counter\nomp_ingest_start_deviation_ms_sum %d\n", metrics.DeviationSumMs.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_start_deviation_ms_max Größte Startabweichung seit Start\n# TYPE omp_ingest_start_deviation_ms_max gauge\nomp_ingest_start_deviation_ms_max %d\n", metrics.DeviationMaxMs.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_late_starts_total Starts über dem Abweichungs-Zielwert\n# TYPE omp_ingest_late_starts_total counter\nomp_ingest_late_starts_total %d\n", metrics.LateStarts.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_orphans_reaped_total Verwaiste Rekorder, die beendet wurden\n# TYPE omp_ingest_orphans_reaped_total counter\nomp_ingest_orphans_reaped_total %d\n", metrics.OrphansReaped.Load())
	fmt.Fprintf(w, "# HELP omp_ingest_admission_rejected_total Zulassungen, die blockiert wurden\n# TYPE omp_ingest_admission_rejected_total counter\nomp_ingest_admission_rejected_total %d\n", metrics.AdmitRejected.Load())
}

// channelCount: Audio-Kanäle der Quelle laut Registry (ok=false, wenn die Quelle gerade nicht auffindbar ist oder die Zahl unbekannt bleibt).
func (m *Module) channelCount(src Source) (int, bool) {
	if m.S.Nodes == nil {
		return 0, false
	}
	for _, n := range m.S.Nodes.List() {
		if !n.Online || (src.InstanceID != "" && n.InstanceID != src.InstanceID) {
			continue
		}
		for _, s := range n.Senders {
			if !strings.Contains(s.Format, "audio") || s.ChannelCount <= 0 {
				continue
			}
			if (src.SenderID != "" && s.ID != src.SenderID) || (src.SenderID == "" && src.SenderLabel != "" && s.Label != src.SenderLabel) {
				continue
			}
			return s.ChannelCount, true
		}
	}
	return 0, false
}

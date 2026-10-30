// Package review ist das Modul „Eingang / Review“ (UMSETZUNG.md Kapitel 43): Arbeitsliste neu eingegangener Medien-Assets,
// automatische technische Datei-QC, Review mit framegenauem Player, nicht-destruktives Conform (Segmente) und Metadaten mit
// Revisions-/Freigabe-Ablauf. Die Originaldatei bleibt immer unverändert.
package review

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/subtitlegen"
)

const settingsKey = "review.config"

// Module ist das Review-Modul. Das Zero-Value ist nutzbar (eigener asset.Store, Standardverzeichnisse).
type Module struct {
	Assets  *asset.Store // optional: derselbe Store wie im Kern (mit Outbox)
	DataDir string       // Proxies; leer = $OMP_REVIEW_DIR oder data/review
	Tools   *Tools       // optional (Tests)
	// QCRunner/ProxyRunner: optional — QC- bzw. Proxy-Läufe über den Job-Dispatcher (Host-Auswahl, Sendeschutz).
	QCRunner, ProxyRunner Runner
	// SubtitleNodes: erreichbare Auto-Untertitel-Nodes für „SRT erzeugen“ (Sprecher- und Spracherkennung); nil = Funktion aus.
	SubtitleNodes func() []subtitlegen.Target

	mu  sync.Mutex
	svc *Service
	cfg cfgHolder
	// cfgMu serialisiert Lesen-Ändern-Schreiben des Einstellungsdokuments (Profilverwaltung).
	cfgMu sync.Mutex

	qcRuns, qcFailures, qcExecFailures atomic.Int64
	qcSecondsMilli                     atomic.Int64
}

// New: Konstruktor für main.go.
func New(assets *asset.Store) *Module { return &Module{Assets: assets} }

func (*Module) Name() string { return "review" }

// cfgHolder liest das Einstellungsdokument mit kurzem Cache.
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
		slog.Warn("review: Konfiguration ungültig, Standardwerte aktiv", "error", err)
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
	if m.Assets == nil {
		m.Assets = asset.NewStore(d.DB)
	}
	dir := m.DataDir
	if dir == "" {
		if dir = os.Getenv("OMP_REVIEW_DIR"); dir == "" {
			dir = filepath.Join("data", "review")
		}
	}
	tools := m.Tools
	if tools == nil {
		tools = NewTools(os.Getenv("OMP_FFMPEG"), os.Getenv("OMP_FFPROBE"))
	}
	if m.QCRunner != nil && tools.QCJobs == nil {
		tools.QCJobs = m.QCRunner
	}
	if m.ProxyRunner != nil && tools.ProxyJobs == nil {
		tools.ProxyJobs = m.ProxyRunner
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
	m.svc = &Service{St: NewStore(d.DB), Assets: m.Assets, Tools: tools, Cfg: m.cfg.Get, DataDir: dir, Audit: d.Audit, SubNodes: m.SubtitleNodes}
	asset.RegisterPurgeHook("review", m.svc.purgeAssets)
	return m.svc
}

// Mount meldet die Routen an (Rechtepflicht je Route ausgeschrieben).
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	svc := m.service(d)
	a := &api{svc: svc, m: m, settings: d.Settings, access: d.Access}
	r.Handle("GET /api/v1/review/items", module.Authenticated(), a.listItems())
	r.Handle("GET /api/v1/review/items/{id}", module.Authenticated(), a.getItem())
	r.Handle("GET /api/v1/review/items/{id}/history", module.Authenticated(), a.history())
	r.Handle("POST /api/v1/review/items/{id}/claim", module.Feature("review.work"), a.claim())
	r.Handle("POST /api/v1/review/items/{id}/release", module.Feature("review.work"), a.release(false))
	r.Handle("POST /api/v1/review/items/{id}/force-release", module.Feature("review.assign"), a.release(true))
	r.Handle("POST /api/v1/review/items/{id}/assign", module.Feature("review.assign"), a.assign())
	r.Handle("POST /api/v1/review/items/{id}/reassign", module.Feature("review.assign"), a.reassign())
	r.Handle("POST /api/v1/review/items/{id}/qc", module.Feature("review.qc.run"), a.requestQC())
	r.Handle("POST /api/v1/review/items/{id}/compare", module.Feature("review.work"), a.compare())
	r.Handle("GET /api/v1/review/items/{id}/qc/reports", module.Authenticated(), a.listReports())
	r.Handle("GET /api/v1/review/items/{id}/qc/jobs", module.Authenticated(), a.listJobs())
	r.Handle("GET /api/v1/review/qc/reports/{rid}", module.Authenticated(), a.getReport())
	r.Handle("GET /api/v1/review/qc/reports/{rid}/export", module.Authenticated(), a.exportReport())
	r.Handle("GET /api/v1/review/items/{id}/conform", module.Authenticated(), a.getConform())
	r.Handle("PUT /api/v1/review/items/{id}/conform", module.Feature("review.work"), a.saveConform())
	r.Handle("GET /api/v1/review/items/{id}/conforms", module.Authenticated(), a.listConforms())
	r.Handle("POST /api/v1/review/items/{id}/submit", module.Feature("review.work"), a.submit())
	r.Handle("POST /api/v1/review/items/{id}/withdraw", module.Feature("review.work"), a.withdraw())
	r.Handle("POST /api/v1/review/items/{id}/revise", module.Feature("review.work"), a.revise())
	r.Handle("POST /api/v1/review/items/{id}/approve", module.Feature("review.approve"), a.decide(true))
	r.Handle("POST /api/v1/review/items/{id}/reject", module.Feature("review.approve"), a.decide(false))
	r.Handle("POST /api/v1/review/items/{id}/archive", module.Feature("review.approve"), a.archive(true))
	r.Handle("POST /api/v1/review/items/{id}/unarchive", module.Feature("review.approve"), a.archive(false))
	r.Handle("POST /api/v1/review/items/{id}/proxy", module.Feature("review.work", "review.qc.run"), a.requestProxy())
	r.Handle("GET /api/v1/review/items/{id}/proxy", module.Authenticated(), a.proxyStatus())
	r.Handle("GET /api/v1/review/items/{id}/timecode", module.Authenticated(), a.timecode())
	r.Handle("GET /api/v1/review/media/{id}/proxy", module.Authenticated(), a.serveProxy())
	r.Handle("GET /api/v1/review/media/{id}/audio/{track}/{block}", module.Authenticated(), a.serveAudioBlock())
	r.Handle("GET /api/v1/review/media/{id}/peaks/{track}", module.Authenticated(), a.servePeaks())
	r.Handle("GET /api/v1/review/media/{id}/frame/{n}", module.Authenticated(), a.serveFrame())
	r.Handle("GET /api/v1/review/import/files", module.Feature("review.import"), a.importList())
	r.Handle("POST /api/v1/review/import", module.Feature("review.import"), a.importFile())
	r.Handle("POST /api/v1/review/register", module.Feature("review.import"), a.registerAsset())
	r.Handle("POST /api/v1/review/items/{id}/subtitles", module.Feature("review.work"), a.startSubtitles())
	r.Handle("GET /api/v1/review/items/{id}/subtitles", module.Authenticated(), a.listSubtitles())
	r.Handle("POST /api/v1/review/subtitles/{sid}/cancel", module.Feature("review.work"), a.cancelSubtitle())
	r.Handle("DELETE /api/v1/review/subtitles/{sid}", module.Feature("review.work"), a.deleteSubtitle())
	r.Handle("GET /api/v1/review/subtitles/{sid}/srt", module.Authenticated(), a.downloadSubtitle())
	r.Handle("GET /api/v1/review/config", module.Authenticated(), a.getConfig())
	r.Handle("PUT /api/v1/review/config", module.Verb(authz.VerbAdmin), a.putConfig())
	r.Handle("GET /api/v1/review/qc-profiles", module.Authenticated(), a.listProfiles())
	r.Handle("PUT /api/v1/review/qc-profiles/{id}", module.Verb(authz.VerbAdmin), a.putProfile())
	r.Handle("DELETE /api/v1/review/qc-profiles/{id}", module.Verb(authz.VerbAdmin), a.deleteProfile())
	r.Handle("POST /api/v1/review/qc-profiles/default", module.Verb(authz.VerbAdmin), a.setDefaultProfile())
	return nil
}

// UI: Tab „Eingang“ in der Hauptleiste, nach „Assets“; dazu der Editor der QC-Profile in der Administration (Plattform → Betrieb).
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "review", Placement: "main", After: "assets",
		Label:   map[string]string{"de": "File Eingangskontrolle", "en": "File intake control"},
		Element: "omp-review-view", Bundle: "/dist/modules/review.js",
	}, {
		ID: "qc-profiles", Placement: "admin:platform", After: "jobs",
		Label: map[string]string{"de": "QC-Profile", "en": "QC profiles"},
		Group: map[string]string{"de": "Plattform", "en": "Platform"}, Cluster: "operations",
		Element: "omp-qc-profiles-view", Bundle: "/dist/modules/review.js",
	}}
}

// Start: Hintergrundarbeiter (nur auf dem Raft-Leader, endet mit ctx).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	svc := m.service(d)
	svc.CleanupProxies(ctx)
	go m.run(ctx, svc)
	return nil
}

func (m *Module) run(ctx context.Context, svc *Service) {
	log := slog.With("module", "review")
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // Untertitel-Aufträge: Fortschritt abholen, Ergebnisse ablegen
		defer wg.Done()
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			svc.PollSubtitles(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	for i := 0; i < 4; i++ { // bis zu 4 Arbeiter; tatsächlich aktiv: cfg.QCWorkers
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			t := time.NewTicker(2 * time.Second)
			defer t.Stop()
			for {
				if n < svc.Cfg().QCWorkers {
					for {
						start := time.Now()
						ran, err := svc.RunNextQC(ctx)
						if ran {
							m.qcRuns.Add(1)
							m.qcSecondsMilli.Add(time.Since(start).Milliseconds())
						}
						if err != nil {
							log.Warn("QC-Arbeiter", "error", err)
						}
						if !ran || ctx.Err() != nil {
							break
						}
					}
					for {
						ran, err := svc.RunNextProxy(ctx)
						if err != nil {
							log.Warn("Proxy-Arbeiter", "error", err)
						}
						if !ran || ctx.Err() != nil {
							break
						}
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		scan := time.NewTicker(15 * time.Second)
		stale := time.NewTicker(30 * time.Second)
		clean := time.NewTicker(10 * time.Minute)
		src := time.NewTicker(60 * time.Second)
		defer scan.Stop()
		defer stale.Stop()
		defer clean.Stop()
		defer src.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-scan.C:
				if svc.Cfg().AutoQC {
					if n, err := svc.ScanNew(ctx); err != nil {
						log.Warn("Eingangs-Scan", "error", err)
					} else if n > 0 {
						log.Info("neue Assets im Eingang", "count", n)
					}
				}
			case <-stale.C:
				if re, err := svc.St.RequeueStale(ctx, 90*time.Second, 3); err == nil {
					for _, j := range re {
						log.Warn("QC-Auftrag ohne Lebenszeichen", "asset", j.AssetID, "job", j.ID, "now", j.State)
						if j.State == JobExecFail {
							svc.failJob(ctx, j, j.Error)
						}
					}
				}
			case <-src.C:
				svc.RescanSources(ctx)
			case <-clean.C:
				svc.CleanupProxies(ctx)
			}
		}
	}()
	wg.Wait()
}

// WriteMetrics: Kennzahlen für GET /metrics (Warteschlange, Zustände, Laufzeit).
func (m *Module) WriteMetrics(w io.Writer) {
	m.mu.Lock()
	svc := m.svc
	m.mu.Unlock()
	if svc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	emit := func(name, help, label string, q string) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
		rows, err := svc.St.db.QueryContext(ctx, q)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			var n int64
			if rows.Scan(&k, &n) == nil {
				fmt.Fprintf(w, "%s{%s=%q} %d\n", name, label, k, n)
			}
		}
	}
	emit("omp_review_items", "Einträge der Review-Arbeitsliste je Zustand", "state", `SELECT state, COUNT(*) FROM review_items GROUP BY state`)
	emit("omp_review_qc_jobs", "QC-Aufträge je Zustand", "state", `SELECT state, COUNT(*) FROM qc_jobs GROUP BY state`)
	emit("omp_review_proxies", "Review-Proxys je Zustand", "state", `SELECT state, COUNT(*) FROM review_proxies GROUP BY state`)
	fmt.Fprintf(w, "# HELP omp_review_qc_runs_total Ausgeführte QC-Läufe seit Start\n# TYPE omp_review_qc_runs_total counter\nomp_review_qc_runs_total %d\n", m.qcRuns.Load())
	fmt.Fprintf(w, "# HELP omp_review_qc_seconds_total Summe der QC-Laufzeit seit Start\n# TYPE omp_review_qc_seconds_total counter\nomp_review_qc_seconds_total %.3f\n", float64(m.qcSecondsMilli.Load())/1000)
	var oldest sql_NullFloat
	_ = svc.St.db.QueryRowContext(ctx, `SELECT EXTRACT(EPOCH FROM now() - MIN(created_at)) FROM qc_jobs WHERE state='queued'`).Scan(&oldest)
	fmt.Fprintf(w, "# HELP omp_review_qc_oldest_queued_seconds Alter des ältesten wartenden QC-Auftrags\n# TYPE omp_review_qc_oldest_queued_seconds gauge\nomp_review_qc_oldest_queued_seconds %.0f\n", oldest.v)
}

type sql_NullFloat struct{ v float64 }

func (n *sql_NullFloat) Scan(src any) error {
	switch x := src.(type) {
	case float64:
		n.v = x
	case nil:
		n.v = 0
	}
	return nil
}

// RescanSources: Quelldatei verändert → neue QC (und der Entwurf verlangt Bestätigung beim nächsten Speichern).
func (s *Service) RescanSources(ctx context.Context) {
	items, err := s.St.ListItems(ctx, ListFilter{States: []string{StateAwaitingReview, StateInReview, StateConforming, StateQCFailedToRun, StateRejected}, Limit: 500})
	if err != nil {
		return
	}
	for _, it := range items {
		p, err := s.sourcePath(it)
		if err != nil {
			continue
		}
		if fp, err := Fingerprint(p); err == nil && fp != it.SourceRev {
			if _, _, err := s.RequestQC(ctx, it.AssetID, "system", "", false); err != nil {
				s.log().Warn("Quelländerung erkannt, QC nicht planbar", "asset", it.AssetID, "error", err)
			}
		}
	}
}

var _ = json.Marshal

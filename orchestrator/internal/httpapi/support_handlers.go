package httpapi

import (
	"strings"
	"sync"

	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/infantilo/openmediaplatform/jobwire"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"runtime/pprof"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/trends"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
)

// Selbsttest und Support-Paket (UMSETZUNG.md Kap. 72). Beide sammeln ihre Daten über den eigenen Router mit den
// Anmeldedaten der aufrufenden Person: gleiche Rechteprüfung und gleiche Aufbereitung wie die Oberfläche, keine
// zweite Datenzugriffsschicht.

// HostSysinfoFunc holt den Rechnerzustand eines Remote-Hosts (implementiert von *launcher.Launcher.SysinfoOnHost).
type HostSysinfoFunc func(hostID string) (jobwire.Sysinfo, error)

// WithHostSysinfo aktiviert die Host-Auswertung im Selbsttest und die Host-Berichte im Support-Paket.
func WithHostSysinfo(f HostSysinfoFunc) HandlerOption {
	return func(o *handlerOptions) { o.hostSysinfo = f }
}

// hostSys ist das Ergebnis eines Abrufs (Fehler: Grund, z. B. älterer Host-Agent).
type hostSys struct {
	Info jobwire.Sysinfo
	Err  string
	at   time.Time
}

// sysCache hält die Antworten kurz vor, damit der Selbsttest (alle 30 s je offenem Browser) die Hosts nicht dauernd befragt.
type sysCache struct {
	fetch HostSysinfoFunc
	ttl   time.Duration
	mu    sync.Mutex
	byID  map[string]hostSys
}

func newSysCache(f HostSysinfoFunc, ttl time.Duration) *sysCache {
	return &sysCache{fetch: f, ttl: ttl, byID: map[string]hostSys{}}
}

// get liefert die (ggf. zwischengespeicherte) Antwort; fresh erzwingt eine neue Abfrage (Support-Paket).
func (c *sysCache) get(hostID string, fresh bool) hostSys {
	if c == nil || c.fetch == nil {
		return hostSys{Err: "not available"}
	}
	c.mu.Lock()
	cur, ok := c.byID[hostID]
	c.mu.Unlock()
	if ok && !fresh && time.Since(cur.at) < c.ttl {
		return cur
	}
	res := hostSys{at: time.Now()}
	if info, err := c.fetch(hostID); err != nil {
		res.Err = err.Error()
	} else {
		res.Info = info
	}
	c.mu.Lock()
	c.byID[hostID] = res
	c.mu.Unlock()
	return res
}

// fetchAll fragt alle Hosts parallel ab.
func (c *sysCache) fetchAll(ids []string, fresh bool) map[string]hostSys {
	out := make(map[string]hostSys, len(ids))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			r := c.get(id, fresh)
			mu.Lock()
			out[id] = r
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

// loopbackGet ruft einen GET-Endpunkt des eigenen Routers auf, als wäre es die aufrufende Person.
func loopbackGet(ctx context.Context, h http.Handler, src *http.Request, path string) ([]byte, int) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, 0
	}
	for _, k := range []string{"Authorization", "Cookie", "Accept-Language"} {
		if v := src.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	req.RemoteAddr = src.RemoteAddr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Body.Bytes(), rec.Code
}

func loopbackJSON(ctx context.Context, h http.Handler, src *http.Request, path string, out any) bool {
	body, code := loopbackGet(ctx, h, src, path)
	return code == http.StatusOK && json.Unmarshal(body, out) == nil
}

// collectSelftestInputs misst den lokalen Rechner und liest die Betriebsdaten.
func collectSelftestInputs(ctx context.Context, h http.Handler, src *http.Request, raftDir string, lang string, clusterSvc ClusterService, sc *sysCache, fresh bool, ta ...*trends.Analyzer) (support.Inputs, map[string]hostSys) {
	targets := []support.DiskTarget{{Path: "/", Label: map[bool]string{true: "system", false: "System"}[lang == "en"]}}
	if raftDir != "" {
		if _, err := os.Stat(raftDir); err == nil {
			targets = append(targets, support.DiskTarget{Path: raftDir, Label: map[bool]string{true: "data", false: "Daten"}[lang == "en"]})
		}
	}
	in := support.Inputs{Local: support.ProbeLocal(targets)}

	switch _, code := loopbackGet(ctx, h, src, "/api/v1/logs?limit=1"); {
	case code == http.StatusOK:
		in.Local.DatabaseError = ""
	case code >= 500:
		in.Local.DatabaseError = fmt.Sprintf("HTTP %d", code)
	}

	var hs []struct {
		ID       string         `json:"id"`
		Label    string         `json:"label"`
		Hostname string         `json:"hostname"`
		Metrics  *hosts.Metrics `json:"metrics"`
	}
	if loopbackJSON(ctx, h, src, "/api/v1/hosts", &hs) {
		now := time.Now()
		for _, x := range hs {
			host := support.Host{ID: x.ID, Label: x.Label, TelemetryAge: -1}
			if host.Label == "" {
				host.Label = x.Hostname
			}
			if m := x.Metrics; m != nil {
				host.Goodbye, host.CPUPercent, host.MemUsed, host.MemTotal = m.Goodbye, m.CPUPercent, m.MemUsedBytes, m.MemTotalBytes
				if !m.ReceivedAt.IsZero() {
					host.TelemetryAge = now.Sub(m.ReceivedAt)
				}
				host.ClockProblem = clockProblemText(m.Clock.Problem(), lang)
			}
			in.Hosts = append(in.Hosts, host)
		}
	}
	// Rechnerzustand der erreichbaren Hosts (Host-Agent, Aktion sysinfo).
	var live []string
	for _, h := range in.Hosts {
		if !h.Goodbye && h.TelemetryAge >= 0 && h.TelemetryAge <= 30*time.Second {
			live = append(live, h.ID)
		}
	}
	var sysByHost map[string]hostSys
	if sc != nil && sc.fetch != nil && len(live) > 0 {
		sysByHost = sc.fetchAll(live, fresh)
		for i := range in.Hosts {
			if r, ok := sysByHost[in.Hosts[i].ID]; ok && r.Err == "" {
				l := support.LocalFromSysinfo(r.Info)
				in.Hosts[i].Sys = &l
			}
		}
	}
	var is []launcher.Instance
	if loopbackJSON(ctx, h, src, "/api/v1/instances", &is) {
		for _, i := range is {
			in.Instances = append(in.Instances, support.Instance{ID: i.ID, Label: i.Label, Type: i.Type, Crashed: i.Crashed,
				CrashMessage: i.CrashMessage, RestartCount: i.RestartCount, Outdated: i.Outdated})
		}
	}
	var ns []registry.NodeView
	if loopbackJSON(ctx, h, src, "/api/v1/nodes", &ns) {
		for _, n := range ns {
			if n.Online {
				in.NodesOnline++
			} else {
				in.NodesOffline = append(in.NodesOffline, n.Label)
			}
		}
	}
	if clusterSvc != nil {
		st := clusterSvc.Status()
		in.Cluster = support.Cluster{Known: true, State: st.State, Members: len(st.Peers), NoLeaderSeconds: st.NoLeaderSeconds, QuorumLost: st.QuorumLost}
	}
	var pf struct {
		Profile  string                                         `json:"profile"`
		Findings []struct{ ID, Severity, Message, Hint string } `json:"findings"`
	}
	if loopbackJSON(ctx, h, src, "/api/v1/admin/profile", &pf) {
		in.Profile = pf.Profile
		for _, f := range pf.Findings {
			in.Findings = append(in.Findings, support.Finding{ID: f.ID, Severity: f.Severity, Message: f.Message, Hint: f.Hint})
		}
	}
	if len(ta) > 0 {
		in.Trends = trendInputs(ta[0])
	}
	return in, sysByHost
}

func clockProblemText(code, lang string) string {
	en := lang == "en"
	switch code {
	case "":
		return ""
	case "unsynced+tai":
		if en {
			return "not synchronised, no TAI offset"
		}
		return "nicht synchronisiert, kein TAI-Versatz"
	case "unsynced":
		if en {
			return "not synchronised"
		}
		return "nicht synchronisiert"
	case "tai":
		if en {
			return "no TAI offset"
		}
		return "kein TAI-Versatz"
	}
	return code
}

// handleSelftest liefert GET /api/v1/admin/selftest.
func handleSelftest(h http.Handler, raftDir string, clusterSvc ClusterService, sc *sysCache, ta ...*trends.Analyzer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		lang := requestLang(r)
		in, _ := collectSelftestInputs(ctx, h, r, raftDir, lang, clusterSvc, sc, false, ta...)
		writeJSON(w, http.StatusOK, support.Evaluate(in, lang, time.Now()))
	}
}

const supportReadme = `OpenMediaPlatform — Support-Paket / support package
====================================================

Dieses Paket beschreibt den Zustand des Systems zum Zeitpunkt der Erstellung.
Es enthält KEINE Medien, KEINE Passwörter, Tokens oder privaten Schlüssel
(Werte unter Schlüsseln wie password/secret/token/key sind durch [entfernt]
ersetzt, ebenso Zugangsdaten in Adressen und Bearer-Header im Text).
Es enthält auch kein Audit-Log und keine Nutzerliste.

This package describes the state of the system when it was created. It contains
NO media, NO passwords, tokens or private keys (values under keys such as
password/secret/token/key are replaced with [entfernt]).

Dateien / files
  manifest.json      Zeit, Zeitraum, enthaltene Dateien, fehlgeschlagene Teile
  selftest.json      Ampel-Selbsttest (Befunde mit nächstem Schritt)
  api/*.json         Version, Nodes, Instanzen, Hosts, Cluster, Einstellungen, Workflows ...
  logs/*.json        Fehler und Warnungen des gewählten Zeitraums, gruppierte Probleme
  system/*.txt       Betriebssystem, Speicher, Platten, Prozesse, Kernel-Meldungen
  orchestrator/*.txt Goroutinen-Bericht und Speicherstatistik des Orchestrators

Bitte die ganze ZIP-Datei an den Support senden. / Please send the whole ZIP file to support.
`

// handleSupportBundle liefert GET /api/v1/admin/support-bundle?minutes=N als ZIP.
func handleSupportBundle(h http.Handler, raftDir string, clusterSvc ClusterService, sc *sysCache, ta ...*trends.Analyzer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		minutes := 120
		if v, err := strconv.Atoi(r.URL.Query().Get("minutes")); err == nil && v > 0 {
			minutes = min(v, 7*24*60)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		now := time.Now()
		since := now.Add(-time.Duration(minutes) * time.Minute).UTC().Format(time.RFC3339)
		failed := map[string]string{}
		var files []support.File
		add := func(name string, data []byte) {
			files = append(files, support.File{Name: name, Data: support.Redact(name, data)})
		}

		// Selbsttest in Deutsch und Englisch ist unnötig — in der Sprache der Anfrage.
		lang := requestLang(r)
		in, sysByHost := collectSelftestInputs(ctx, h, r, raftDir, lang, clusterSvc, sc, true, ta...)
		rep := support.Evaluate(in, lang, now)
		if b, err := json.MarshalIndent(rep, "", "  "); err == nil {
			add("selftest.json", b)
		}

		for _, s := range []struct{ file, path string }{
			{"api/version.json", "/api/v1/version"},
			{"api/errorcodes.json", "/api/v1/errorcodes"},
			{"api/trends.json", "/api/v1/admin/trends"},
			{"api/info.json", "/api/v1/info"},
			{"api/nodes.json", "/api/v1/nodes"},
			{"api/instances.json", "/api/v1/instances"},
			{"api/hosts.json", "/api/v1/hosts"},
			{"api/cluster.json", "/api/v1/cluster/status"},
			{"api/profile.json", "/api/v1/admin/profile"},
			{"api/kpi-media.json", "/api/v1/kpi/media?window=24h"},
			{"api/settings-system.json", "/api/v1/admin/settings/system"},
			{"api/node-versions.json", "/api/v1/admin/node-versions"},
			{"api/workflows.json", "/api/v1/workflows"},
			{"api/graph.json", "/api/v1/graph"},
			{"api/network.json", "/api/v1/graph/network"},
			{"api/alarm-acks.json", "/api/v1/alarms/acks"},
			{"logs/problems.json", "/api/v1/logs/summary?level=error,warn&since=" + since},
			{"logs/errors-and-warnings.json", "/api/v1/logs?level=error,warn&limit=500&since=" + since},
			{"logs/all-recent.json", "/api/v1/logs?limit=500&since=" + since},
		} {
			body, code := loopbackGet(ctx, h, r, s.path)
			if code != http.StatusOK {
				failed[s.file] = "HTTP " + strconv.Itoa(code)
				continue
			}
			add(s.file, body)
		}

		// Dieser Rechner und jeder erreichbare Host: gleicher Textbericht (jobwire.CollectReport).
		localFiles, localFailed := jobwire.CollectReport(ctx)
		for name, text := range localFiles {
			add("system/"+name, []byte(text))
		}
		for name, why := range localFailed {
			failed["system/"+name] = why
		}
		labels := map[string]string{}
		for _, h := range in.Hosts {
			labels[h.ID] = h.Label
		}
		for id, res := range sysByHost {
			dir := "hosts/" + sanitizeFileName(labels[id]+"-"+id[:min(8, len(id))]) + "/"
			if res.Err != "" {
				failed[dir+"sysinfo"] = res.Err
				continue
			}
			files := res.Info.Files
			res.Info.Files = nil
			if b, err := json.MarshalIndent(res.Info, "", "  "); err == nil {
				add(dir+"sysinfo.json", b)
			}
			for name, text := range files {
				add(dir+name, []byte(text))
			}
		}

		var gor bytes.Buffer
		_ = pprof.Lookup("goroutine").WriteTo(&gor, 1)
		add("orchestrator/goroutines.txt", gor.Bytes())
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		add("orchestrator/runtime.txt", []byte(fmt.Sprintf("version %s\ngo %s\ngoroutines %d\nheap alloc %d MiB\nheap sys %d MiB\ngc runs %d\n",
			version.Version, runtime.Version(), runtime.NumGoroutine(), ms.HeapAlloc>>20, ms.HeapSys>>20, ms.NumGC)))

		add("README.txt", []byte(supportReadme))
		man := support.Manifest{CreatedAt: now.UTC(), Window: fmt.Sprintf("%d min", minutes), Failed: failed}
		for _, f := range files {
			man.Files = append(man.Files, f.Name)
		}
		man.Files = append(man.Files, "manifest.json")
		mb, _ := json.MarshalIndent(man, "", "  ")
		files = append(files, support.File{Name: "manifest.json", Data: mb})

		host, _ := os.Hostname()
		name := fmt.Sprintf("omp-support-%s-%s.zip", sanitizeFileName(host), now.Format("20060102-150405"))
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("Cache-Control", "no-store")
		slog.Info("support bundle created", "remote", r.RemoteAddr, "files", len(files), "failed", len(failed))
		if err := support.WriteZip(w, files, now); err != nil {
			slog.Warn("support bundle write failed", "err", err)
		}
	}
}

func sanitizeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "host"
	}
	return b.String()
}

// Package extsvc ist das Dienst-Gateway des Orchestrators (ARCHITECTURE.md §28.2 „Stufe 2“, UMSETZUNG.md Kapitel 48):
// Fachdienste laufen als eigene Prozesse (Nodes) und melden ein Manifest (`GET /service.json`). Das Gateway stellt
// `/api/v1/ext/<dienst>/…` bereit, prüft das Funktionsrecht der Route, reicht die Identität mit, schreibt das Audit und
// bringt Funktionsrechte, Tabs, Kacheln und Metriken des Dienstes wie die eines Moduls in die Plattform. Es kennt
// keinen Dienst beim Namen.
package extsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

const (
	refreshEvery   = 15 * time.Second
	manifestsKey   = "extsvc.manifests"
	importedPrefix = "extsvc.imported."
	backupPrefix   = "extsvc.backup."
	maxBody        = 1 << 20
)

// Header, die das Gateway an den Dienst schickt. Der Dienst vertraut ihnen nur mit gültigem Dienst-Geheimnis.
const (
	HToken       = "X-OMP-Service-Token"
	HUser        = "X-OMP-User"
	HGroups      = "X-OMP-Groups"
	HFeatures    = "X-OMP-Features"
	HRequestHost = "X-OMP-Request-Host"
	HNodeBase    = "X-OMP-Node-Base"
	// HAudit: Antwort-Header des Dienstes (URL-kodiertes JSON `{"object","action","details"}`) fürs Audit-Log.
	HAudit = "X-OMP-Audit"
)

// NodeLister ist die schmale Sicht auf die Registry.
type NodeLister interface{ List() []registry.NodeView }

// Secrets liefert das Dienst-Geheimnis einer Node-Instanz (der Launcher kennt es; leer = unbekannt).
type Secrets interface {
	Secret(instanceID string) string
}

// Services: die vom Kern bereitgestellten Bausteine (main.go füllt sie, nachdem alle Dienste existieren).
type Services struct {
	Nodes   NodeLister
	Secrets Secrets
	HTTP    *http.Client
	Now     func() time.Time
}

type live struct {
	manifest Manifest
	node     registry.NodeView
}

// Module ist das Gateway.
type Module struct {
	// bg: der Abgleich, den Mount im Hintergrund anstößt (Tests warten darauf, bevor sie die Dienste umstellen)
	bg sync.WaitGroup
	S  Services

	mu       sync.Mutex
	d        module.Deps
	mounted  bool
	cached   map[string]Manifest // zuletzt bekannte Manifeste (auch ohne laufenden Node, persistiert)
	live     map[string]live     // aktuell erreichbare Dienste
	negative map[string]bool     // Node-ID → bietet keinen Dienst an
	last     time.Time
	loading  bool
	metrics  struct {
		at   time.Time
		text string
	}
	loadedCache bool
}

func New(s Services) *Module {
	return &Module{S: s, cached: map[string]Manifest{}, live: map[string]live{}, negative: map[string]bool{}}
}

func (*Module) Name() string { return "extsvc" }

func (m *Module) client() *http.Client {
	if m.S.HTTP != nil {
		return m.S.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (m *Module) now() time.Time {
	if m.S.Now != nil {
		return m.S.Now()
	}
	return time.Now()
}

// Mount hängt den Catch-all unter `/api/v1/ext/` ein. Die Rechte prüft der Handler selbst, je Route des Manifests; die
// Anmeldung verlangt schon das Gateway des Kerns (`Authenticated`).
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	m.mu.Lock()
	m.d, m.mounted = d, true
	m.mu.Unlock()
	m.loadCache()
	r.Handle("GET /api/v1/ext", module.Authenticated(), m.discover)
	r.Handle("GET /api/v1/ext/{svc}/_ui/{file...}", module.Anonymous(), m.serveUI)
	r.Handle("GET /api/v1/ext/{svc}/{rest...}", module.Authenticated(), m.serve)
	r.Handle("POST /api/v1/ext/{svc}/{rest...}", module.Authenticated(), m.serve)
	r.Handle("PUT /api/v1/ext/{svc}/{rest...}", module.Authenticated(), m.serve)
	r.Handle("PATCH /api/v1/ext/{svc}/{rest...}", module.Authenticated(), m.serve)
	r.Handle("DELETE /api/v1/ext/{svc}/{rest...}", module.Authenticated(), m.serve)
	m.bg.Add(1)
	go func() {
		defer m.bg.Done()
		m.refresh(context.Background())
	}()
	return nil
}

// Start: periodischer Abgleich und Übernahme von Altdaten (nur auf dem Raft-Leader).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	t := time.NewTicker(refreshEvery)
	defer t.Stop()
	for {
		m.refresh(ctx)
		m.importLegacy(ctx)
		m.backupServices(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// ---------- Entdeckung ----------

func (m *Module) loadCache() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.loadedCache || m.d.Settings == nil {
		return
	}
	m.loadedCache = true
	raw, err := m.d.Settings.Get(manifestsKey)
	if err != nil {
		return
	}
	var c map[string]Manifest
	if json.Unmarshal(raw, &c) != nil {
		return
	}
	for n, mf := range c {
		if mf.Validate() == nil && mf.Name == n {
			m.cached[n] = mf
		}
	}
}

type fetchResult int

const (
	fetchOK          fetchResult = iota
	fetchNoService               // der Node antwortet, hat aber keinen (gültigen) Dienst
	fetchUnreachable             // keine Antwort: beim nächsten Durchlauf erneut versuchen
)

func (m *Module) fetchManifest(ctx context.Context, n registry.NodeView) (Manifest, fetchResult) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(n.APIBaseURL, "/")+"/service.json", nil)
	if err != nil {
		return Manifest{}, fetchUnreachable
	}
	resp, err := m.client().Do(req)
	if err != nil {
		return Manifest{}, fetchUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return Manifest{}, fetchNoService
	}
	var mf Manifest
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&mf) != nil {
		return Manifest{}, fetchNoService
	}
	if err := mf.Validate(); err != nil {
		slog.Warn("extsvc: Manifest abgelehnt", "node", n.ID, "error", err)
		return Manifest{}, fetchNoService
	}
	return mf, fetchOK
}

// refresh liest die Manifeste der laufenden Nodes. Nodes ohne Dienst werden nur einmal befragt.
func (m *Module) refresh(ctx context.Context) bool {
	m.mu.Lock()
	if m.loading || m.S.Nodes == nil {
		m.mu.Unlock()
		return false
	}
	m.loading = true
	neg := map[string]bool{}
	for id := range m.negative {
		neg[id] = true
	}
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.loading = false; m.last = m.now(); m.mu.Unlock() }()

	nodes := m.S.Nodes.List()
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	found := map[string]live{}
	present := map[string]bool{}
	noService := []string{}
	for _, n := range nodes {
		present[n.ID] = true
		if !n.Online || n.APIBaseURL == "" || neg[n.ID] {
			continue
		}
		mf, res := m.fetchManifest(ctx, n)
		switch res {
		case fetchNoService:
			noService = append(noService, n.ID)
		case fetchOK:
			if _, dup := found[mf.Name]; !dup {
				found[mf.Name] = live{manifest: mf, node: n}
			}
		}
	}
	m.mu.Lock()
	for _, id := range noService {
		m.negative[id] = true
	}
	for id := range m.negative {
		if !present[id] {
			delete(m.negative, id)
		}
	}
	changed := false
	for name, l := range found {
		if old, ok := m.cached[name]; !ok || !sameManifest(old, l.manifest) {
			m.cached[name] = l.manifest
			changed = true
		}
	}
	m.live = found
	var persist []byte
	if changed {
		persist, _ = json.Marshal(m.cached)
	}
	settings := m.d.Settings
	m.mu.Unlock()
	if persist != nil && settings != nil {
		if err := settings.Put(manifestsKey, persist); err != nil {
			slog.Warn("extsvc: Manifeste nicht gespeichert", "error", err)
		}
	}
	return true
}

func sameManifest(a, b Manifest) bool {
	// Importable wechselt zur Laufzeit und gehört nicht zum Vergleich der gespeicherten Form.
	ja, _ := json.Marshal(stripImportState(a))
	jb, _ := json.Marshal(stripImportState(b))
	return bytes.Equal(ja, jb)
}

func stripImportState(m Manifest) Manifest {
	if m.Import != nil {
		c := *m.Import
		c.Importable = false
		m.Import = &c
	}
	return m
}

// kick startet bei veraltetem Stand einen Abgleich im Hintergrund (Anfragen warten nie darauf).
func (m *Module) kick() {
	m.mu.Lock()
	stale := !m.loading && m.now().Sub(m.last) > refreshEvery
	m.mu.Unlock()
	if stale {
		go m.refresh(context.Background())
	}
}

func (m *Module) manifests() []Manifest {
	m.kick()
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.cached))
	for n := range m.cached {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]Manifest, 0, len(names))
	for _, n := range names {
		out = append(out, m.cached[n])
	}
	return out
}

// ---------- Beitrag zur Plattform: Rechte, Tabs, Kacheln, Metriken ----------

func (m *Module) Features() []module.FeatureDef {
	var out []module.FeatureDef
	for _, mf := range m.manifests() {
		out = append(out, mf.Features...)
	}
	return out
}

func (m *Module) UI() []module.UITab {
	var out []module.UITab
	for _, mf := range m.manifests() {
		for _, t := range mf.UI {
			t.Bundle = mf.BundleURL(t.Bundle)
			out = append(out, t)
		}
	}
	return out
}

func (m *Module) Tiles() []module.UITile {
	var out []module.UITile
	for _, mf := range m.manifests() {
		for _, t := range mf.Tiles {
			t.Bundle = mf.BundleURL(t.Bundle)
			out = append(out, t)
		}
	}
	return out
}

// WriteMetrics holt die Metriken der laufenden Dienste (höchstens alle 5 s, Zeitlimit 2 s je Dienst).
func (m *Module) WriteMetrics(w io.Writer) {
	m.mu.Lock()
	if m.now().Sub(m.metrics.at) < 5*time.Second {
		t := m.metrics.text
		m.mu.Unlock()
		io.WriteString(w, t)
		return
	}
	lives := make([]live, 0, len(m.live))
	for _, l := range m.live {
		lives = append(lives, l)
	}
	m.mu.Unlock()
	sort.Slice(lives, func(i, j int) bool { return lives[i].manifest.Name < lives[j].manifest.Name })
	var b strings.Builder
	for _, l := range lives {
		if l.manifest.Metrics == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		resp, err := m.callNode(ctx, l, http.MethodGet, l.manifest.Metrics, nil, nil)
		cancel()
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			b.Write(body)
		}
	}
	m.mu.Lock()
	m.metrics.at, m.metrics.text = m.now(), b.String()
	m.mu.Unlock()
	io.WriteString(w, b.String())
}

// ---------- Weiterleitung ----------

func (m *Module) callNode(ctx context.Context, l live, method, path string, body []byte, hdr http.Header) (*http.Response, error) {
	secret := ""
	if m.S.Secrets != nil {
		secret = m.S.Secrets.Secret(l.node.InstanceID)
	}
	if secret == "" {
		return nil, errNoSecret
	}
	target := strings.TrimRight(l.node.APIBaseURL, "/") + l.manifest.Base + path
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return nil, err
	}
	for k, vs := range hdr {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set(HToken, secret)
	req.Header.Set(HNodeBase, l.node.APIBaseURL)
	return m.client().Do(req)
}

var errNoSecret = fmt.Errorf("Dienst-Geheimnis unbekannt (der Node wurde nicht vom Orchestrator gestartet)")

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (m *Module) pick(name string) (live, bool) {
	m.kick()
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.live[name]
	return l, ok
}

func (m *Module) can(r *http.Request, features []string) bool {
	m.mu.Lock()
	acc := m.d.Access
	m.mu.Unlock()
	if acc == nil { // ohne Rechte-Speicher (Tests): alles erlaubt, wie im Bootstrap-Modus
		return true
	}
	for _, f := range features {
		if acc.Can(r, f) {
			return true
		}
	}
	return false
}

func (m *Module) serve(w http.ResponseWriter, r *http.Request) {
	name, rest := r.PathValue("svc"), "/"+r.PathValue("rest")
	var mf Manifest
	m.mu.Lock()
	cached, known := m.cached[name]
	m.mu.Unlock()
	if l, ok := m.pick(name); ok {
		mf = l.manifest
	} else if known {
		mf = cached
	} else {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unbekannter Dienst"})
		return
	}
	route, ok := mf.Route(r.Method, rest)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unbekannte Route"})
		return
	}
	if !m.can(r, route.Features) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Funktionsrecht fehlt"})
		return
	}
	l, ok := m.pick(name)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": fmt.Sprintf("Dienst %q läuft nicht", name)})
		return
	}
	var body []byte
	if r.Body != nil && r.Method != http.MethodGet {
		var err error
		if body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody)); err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Anfrage zu groß"})
			return
		}
	}
	hdr := http.Header{}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		hdr.Set("Content-Type", ct)
	}
	actor := module.Actor(r)
	hdr.Set(HUser, actor)
	hdr.Set(HRequestHost, r.Host)
	m.mu.Lock()
	acc := m.d.Access
	m.mu.Unlock()
	var groups []string
	if acc != nil {
		groups = acc.Identity(r).Groups
	}
	hdr.Set(HGroups, strings.Join(groups, ","))
	var have []string
	for _, f := range mf.Features {
		if m.can(r, []string{f.ID}) {
			have = append(have, f.ID)
		}
	}
	hdr.Set(HFeatures, strings.Join(have, ","))
	target := rest
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	resp, err := m.callNode(r.Context(), l, r.Method, target, body, hdr)
	if err != nil {
		slog.Warn("extsvc: Dienst nicht erreichbar", "service", name, "node", l.node.ID, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Dienst nicht erreichbar: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-store")
	m.audit(name, actor, resp)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// audit schreibt den Hinweis des Dienstes (nur bei Erfolg) ins Domänen-Audit-Log.
func (m *Module) audit(service, actor string, resp *http.Response) {
	raw := resp.Header.Get(HAudit)
	if raw == "" || resp.StatusCode >= 300 {
		return
	}
	dec, err := url.QueryUnescape(raw)
	if err != nil {
		return
	}
	var note struct {
		Object  string         `json:"object"`
		Action  string         `json:"action"`
		Details map[string]any `json:"details"`
	}
	if json.Unmarshal([]byte(dec), &note) != nil || note.Action == "" {
		return
	}
	m.mu.Lock()
	a := m.d.Audit
	m.mu.Unlock()
	if a == nil {
		return
	}
	if actor == "" {
		actor = "local"
	}
	a.Log(actor, service, note.Object, note.Action, note.Details)
}

// ---------- Sicherungskopie und Übernahme von Altdaten ----------

func (m *Module) liveServices() []live {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]live, 0, len(m.live))
	for _, l := range m.live {
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].manifest.Name < out[j].manifest.Name })
	return out
}

// backupServices holt den Stand der laufenden Dienste in den Einstellungsspeicher (Datenbank → Datensicherung des
// Orchestrators). Ein leerer Dienst überschreibt nie eine vorhandene Kopie.
func (m *Module) backupServices(ctx context.Context) {
	m.mu.Lock()
	settings := m.d.Settings
	m.mu.Unlock()
	if settings == nil {
		return
	}
	for _, l := range m.liveServices() {
		if l.manifest.Backup == "" || (l.manifest.Import != nil && l.manifest.Import.Importable) {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		resp, err := m.callNode(cctx, l, http.MethodGet, l.manifest.Backup, nil, nil)
		cancel()
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || !json.Valid(body) {
			continue
		}
		key := backupPrefix + l.manifest.Name
		if old, err := settings.Get(key); err == nil && bytes.Equal(old, body) {
			continue
		}
		if err := settings.Put(key, body); err != nil {
			slog.Warn("extsvc: Sicherungskopie nicht gespeichert", "service", l.manifest.Name, "error", err)
		}
	}
}

// importLegacy gibt einem **leeren** Dienst Daten: zuerst die Sicherungskopie (Datei verloren, Node auf anderem Host),
// sonst einmalig die Altdaten aus dem Einstellungsspeicher (z. B. die Intercom-Konfiguration aus der Zeit, als sie ein
// Orchestrator-Modul war; danach steht ein Marker, die Altdaten bleiben unverändert liegen).
func (m *Module) importLegacy(ctx context.Context) {
	m.mu.Lock()
	settings := m.d.Settings
	m.mu.Unlock()
	if settings == nil {
		return
	}
	for _, l := range m.liveServices() {
		imp := l.manifest.Import
		if imp == nil || !imp.Importable {
			continue
		}
		name := l.manifest.Name
		marker := importedPrefix + name
		raw, source, action := []byte(nil), "", ""
		if b, err := settings.Get(backupPrefix + name); err == nil && len(bytes.TrimSpace(b)) > 0 {
			raw, source, action = b, backupPrefix+name, "restore"
		} else if _, err := settings.Get(marker); err != nil {
			legacy, lerr := settings.Get(imp.SettingsKey)
			switch {
			case lerr == nil && len(bytes.TrimSpace(legacy)) > 0:
				raw, source, action = legacy, imp.SettingsKey, "import"
			case lerr == nil || lerr == module.ErrNotFound:
				_ = settings.Put(marker, []byte(`{"done":true}`)) // nichts zu übernehmen: später nie nachträglich importieren
				continue
			default:
				slog.Warn("extsvc: Altdaten nicht lesbar", "service", name, "error", lerr)
				continue
			}
		} else {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		resp, cerr := m.callNode(cctx, l, http.MethodPost, imp.Path, raw, http.Header{"Content-Type": {"application/json"}})
		cancel()
		if cerr != nil {
			slog.Warn("extsvc: Übernahme fehlgeschlagen", "service", name, "error", cerr)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			slog.Warn("extsvc: Dienst lehnt Übernahme ab", "service", name, "status", resp.StatusCode, "body", string(body))
			continue
		}
		slog.Info("extsvc: Daten übernommen", "service", name, "action", action, "from", source)
		if m.d.Audit != nil {
			m.d.Audit.Log("system", name, "config", action, map[string]any{"from": source})
		}
		_ = settings.Put(marker, []byte(`{"done":true}`))
	}
}

// RefreshForTest führt einen Abgleich synchron aus (für Tests außerhalb des Pakets). Läuft gerade der Hintergrundabgleich
// von Mount(), wartet er darauf und holt den eigenen Lauf nach — sonst käme die Anfrage vor dem Manifest an („unbekannter Dienst“).
func (m *Module) RefreshForTest(ctx context.Context) {
	for i := 0; i < 500 && !m.refresh(ctx); i++ {
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------- Entdeckung für Clients, Oberfläche des Dienstes ----------

// Summary: ein Dienst, wie ihn Clients sehen (Typ und Rollen statt Produktname).
type Summary struct {
	Name string `json:"name"`
	Kind string `json:"kind,omitempty"`
	Live bool   `json:"live"`
	// Roles: Rolle → Route (Methode und Pfad relativ zum Dienst; unter `/api/v1/ext/<name>` aufrufbar).
	Roles map[string]RoleRoute `json:"roles,omitempty"`
}

type RoleRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// discover: GET /api/v1/ext — alle bekannten Dienste mit Typ, Rollen und Laufzustand. Die Stream-Deck-Anbindung und andere
// Clients suchen darüber einen Dienst eines Typs (z. B. "intercom"), ohne den Produktnamen zu kennen.
func (m *Module) discover(w http.ResponseWriter, r *http.Request) {
	mfs := m.manifests()
	m.mu.Lock()
	liveNames := map[string]bool{}
	for n := range m.live {
		liveNames[n] = true
	}
	m.mu.Unlock()
	out := make([]Summary, 0, len(mfs))
	for _, mf := range mfs {
		s := Summary{Name: mf.Name, Kind: mf.Kind, Live: liveNames[mf.Name], Roles: map[string]RoleRoute{}}
		for _, rt := range mf.Routes {
			if rt.Role != "" && m.can(r, rt.Features) {
				s.Roles[rt.Role] = RoleRoute{Method: rt.Method, Path: rt.Path}
			}
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, out)
}

// serveUI liefert Dateien aus der Oberfläche des Dienstes (Bundles der Admin-Tabs und Kacheln). Ohne Anmeldung, wie die
// Bundles der Plattform: der Browser lädt sie per `import()` ohne Header; sie enthalten nur Code, keine Daten.
func (m *Module) serveUI(w http.ResponseWriter, r *http.Request) {
	name, file := r.PathValue("svc"), r.PathValue("file")
	if file == "" || strings.Contains(file, "..") || strings.Contains(file, "\\") {
		http.NotFound(w, r)
		return
	}
	l, ok := m.pick(name)
	if !ok {
		http.Error(w, "Dienst läuft nicht", http.StatusServiceUnavailable)
		return
	}
	resp, err := m.callNode(r.Context(), l, http.MethodGet, "/ui/"+file, nil, nil)
	if err != nil {
		http.Error(w, "Dienst nicht erreichbar", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 8<<20))
}

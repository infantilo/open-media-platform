package extsvc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeNodes []registry.NodeView

func (f fakeNodes) List() []registry.NodeView { return f }

type fakeSecrets map[string]string

func (f fakeSecrets) Secret(id string) string { return f[id] }

type fakeSettings struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (f *fakeSettings) Get(k string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.m[k]
	if !ok {
		return nil, module.ErrNotFound
	}
	return v, nil
}
func (f *fakeSettings) Put(k string, d []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.m == nil {
		f.m = map[string][]byte{}
	}
	f.m[k] = d
	return nil
}

type auditEntry struct {
	actor, typ, id, action string
	details                map[string]any
}
type fakeAudit struct {
	mu  sync.Mutex
	log []auditEntry
}

func (f *fakeAudit) Log(actor, typ, id, action string, d map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log = append(f.log, auditEntry{actor, typ, id, action, d})
}

type fakeAccess struct {
	features map[string]bool
	user     string
	groups   []string
}

func (a fakeAccess) Can(_ *http.Request, f string) bool { return a.features[f] }
func (a fakeAccess) Identity(*http.Request) module.Identity {
	return module.Identity{User: a.user, Groups: a.groups}
}

func testManifest(importable bool) Manifest {
	return Manifest{
		Name: "demo", Version: 1, Base: "/service", Metrics: "/metrics",
		Features: []module.FeatureDef{{ID: "demo.use", Label: map[string]string{"de": "Nutzen"}}, {ID: "demo.admin", Label: map[string]string{"de": "Verwalten"}}},
		Routes: []RouteDef{
			{Method: "GET", Path: "/things", Features: []string{"demo.use", "demo.admin"}},
			{Method: "PUT", Path: "/things/{id}", Features: []string{"demo.admin"}},
		},
		UI:     []module.UITab{{ID: "demo", Placement: "admin:production", Label: map[string]string{"de": "Demo"}, Element: "omp-demo", Bundle: "admin.js"}},
		Tiles:  []module.UITile{{ID: "demo", Needs: []string{"demo.use"}, Element: "omp-demo-tile", Bundle: "/dist/modules/demo.js"}},
		Import: &ImportDef{SettingsKey: "demo.legacy", Path: "/import", Importable: importable},
		Backup: "/backup",
	}
}

// rig: ein Dienst-Node (httptest) plus ein Node ohne Dienst, ein Gateway davor.
type rig struct {
	mod      *Module
	node     *httptest.Server
	other    *httptest.Server
	settings *fakeSettings
	audit    *fakeAudit
	gotReq   chan *http.Request
	imported chan string
	otherHit *int
}

func newRig(t *testing.T, acc fakeAccess, importable bool) *rig {
	t.Helper()
	r := &rig{settings: &fakeSettings{}, audit: &fakeAudit{}, gotReq: make(chan *http.Request, 8), imported: make(chan string, 2)}
	mux := http.NewServeMux()
	mux.HandleFunc("/service.json", func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(testManifest(importable)) })
	mux.HandleFunc("/service/", func(w http.ResponseWriter, q *http.Request) {
		if q.Header.Get(HToken) != "geheim" {
			http.Error(w, "kein Geheimnis", http.StatusUnauthorized)
			return
		}
		switch q.URL.Path {
		case "/service/import":
			b, _ := io.ReadAll(q.Body)
			r.imported <- string(b)
			io.WriteString(w, `{"ok":true}`)
			return
		case "/service/ui/admin.js":
			io.WriteString(w, "export const x=1;")
			return
		case "/service/ui/nix.js":
			http.NotFound(w, q)
			return
		case "/service/backup":
			io.WriteString(w, `{"stand":1}`)
			return
		case "/service/metrics":
			io.WriteString(w, "demo_things 3\n")
			return
		}
		q.Body = io.NopCloser(strings.NewReader(""))
		r.gotReq <- q
		note, _ := json.Marshal(map[string]any{"object": "7", "action": "update", "details": map[string]any{"name": "Müller"}})
		w.Header().Set(HAudit, url.QueryEscape(string(note)))
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	})
	r.node = httptest.NewServer(mux)
	t.Cleanup(r.node.Close)
	hits := 0
	r.otherHit = &hits
	r.other = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hits++; http.NotFound(w, nil) }))
	t.Cleanup(r.other.Close)
	nodes := fakeNodes{
		{ID: "n1", Online: true, APIBaseURL: r.other.URL, InstanceID: "i1"},
		{ID: "n2", Online: true, APIBaseURL: r.node.URL, InstanceID: "i2"},
	}
	r.mod = New(Services{Nodes: nodes, Secrets: fakeSecrets{"i2": "geheim"}})
	mux2 := http.NewServeMux()
	if err := r.mod.Mount(muxRoutes{mux2}, module.Deps{Settings: r.settings, Audit: r.audit, Access: acc}); err != nil {
		t.Fatal(err)
	}
	r.mod.refresh(context.Background())
	gw := httptest.NewServer(withUser(mux2, acc.user))
	t.Cleanup(gw.Close)
	r.node.Config.Handler = mux
	t.Setenv("GW", gw.URL)
	return r
}

type muxRoutes struct{ mux *http.ServeMux }

func (m muxRoutes) Handle(p string, _ module.Auth, h http.HandlerFunc) { m.mux.HandleFunc(p, h) }

func withUser(h http.Handler, user string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r.WithContext(module.WithUser(r.Context(), user)))
	})
}

func (r *rig) do(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, getenv(t)+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HUser, "böse") // ein Client darf Identität nie selbst setzen
	req.Header.Set(HFeatures, "demo.admin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func getenv(t *testing.T) string {
	// t.Setenv-Wert zurücklesen (ein Gateway je Test)
	return strings.TrimSpace(osGetenv("GW"))
}

func TestManifestValidation(t *testing.T) {
	ok := testManifest(false)
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*Manifest){
		"Name":             func(m *Manifest) { m.Name = "Böse Name" },
		"Base":             func(m *Manifest) { m.Base = "service" },
		"Base ..":          func(m *Manifest) { m.Base = "/a/../b" },
		"ohne Recht":       func(m *Manifest) { m.Routes[0].Features = nil },
		"nicht deklariert": func(m *Manifest) { m.Routes[0].Features = []string{"demo.nix"} },
		"fremdes Präfix":   func(m *Manifest) { m.Features[0].ID = "andere.use" },
		"Methode":          func(m *Manifest) { m.Routes[0].Method = "TRACE" },
		"Pfad ..":          func(m *Manifest) { m.Routes[0].Path = "/x/../y" },
		"Bundle":           func(m *Manifest) { m.UI[0].Bundle = "http://fremd/x.js" },
	}
	for name, mutate := range cases {
		m := testManifest(false)
		m.Routes = append([]RouteDef(nil), m.Routes...)
		m.Features = append([]module.FeatureDef(nil), m.Features...)
		m.UI = append([]module.UITab(nil), m.UI...)
		mutate(&m)
		if m.Validate() == nil {
			t.Errorf("%s: Manifest hätte abgelehnt werden müssen", name)
		}
	}
}

func TestRouteMatching(t *testing.T) {
	m := testManifest(false)
	if _, ok := m.Route("PUT", "/things/42"); !ok {
		t.Fatal("Platzhalter")
	}
	for _, c := range [][2]string{{"PUT", "/things"}, {"PUT", "/things/42/x"}, {"DELETE", "/things/42"}, {"GET", "/nix"}, {"PUT", "/things/"}} {
		if _, ok := m.Route(c[0], c[1]); ok {
			t.Errorf("%v darf nicht passen", c)
		}
	}
}

func TestGatewayForwardsWithIdentityAndAudits(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true, "demo.admin": true}, user: "anna", groups: []string{"g1", "g2"}}
	r := newRig(t, acc, false)
	code, body := r.do(t, "PUT", "/api/v1/ext/demo/things/7?x=1", `{"a":1}`)
	if code != 200 || !strings.Contains(body, "ok") {
		t.Fatalf("%d %s", code, body)
	}
	q := <-r.gotReq
	if q.URL.Path != "/service/things/7" || q.URL.RawQuery != "x=1" {
		t.Errorf("Ziel: %s?%s", q.URL.Path, q.URL.RawQuery)
	}
	if q.Header.Get(HUser) != "anna" {
		t.Errorf("Identität kommt vom Kern, nicht vom Client: %q", q.Header.Get(HUser))
	}
	if q.Header.Get(HGroups) != "g1,g2" || q.Header.Get(HFeatures) != "demo.use,demo.admin" {
		t.Errorf("Gruppen/Rechte: %q %q", q.Header.Get(HGroups), q.Header.Get(HFeatures))
	}
	if q.Header.Get(HNodeBase) == "" || q.Header.Get(HRequestHost) == "" {
		t.Error("Node-Adresse und Anfrage-Host fehlen")
	}
	if len(r.audit.log) != 1 {
		t.Fatalf("Audit: %+v", r.audit.log)
	}
	a := r.audit.log[0]
	if a.actor != "anna" || a.typ != "demo" || a.id != "7" || a.action != "update" || a.details["name"] != "Müller" {
		t.Errorf("Audit-Eintrag: %+v", a)
	}
}

func TestGatewayRightsAndUnknownRoutes(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true}, user: "bob"}
	r := newRig(t, acc, false)
	if code, _ := r.do(t, "GET", "/api/v1/ext/demo/things", ""); code != 200 {
		t.Errorf("use genügt für GET: %d", code)
	}
	if code, _ := r.do(t, "PUT", "/api/v1/ext/demo/things/1", "{}"); code != 403 {
		t.Errorf("ohne admin 403, war %d", code)
	}
	if code, _ := r.do(t, "DELETE", "/api/v1/ext/demo/things/1", ""); code != 404 {
		t.Errorf("Route ohne Manifest-Eintrag 404, war %d", code)
	}
	if code, _ := r.do(t, "GET", "/api/v1/ext/gibtsnicht/x", ""); code != 404 {
		t.Errorf("unbekannter Dienst 404, war %d", code)
	}
	if len(r.audit.log) != 1 { // nur der erfolgreiche GET oben; abgelehnte Aufrufe schreiben nichts
		t.Errorf("abgelehnte Aufrufe landen nicht im Audit: %+v", r.audit.log)
	}
}

func TestNodeWithoutServiceIsAskedOnce(t *testing.T) {
	r := newRig(t, fakeAccess{}, false)
	first := *r.otherHit
	r.mod.refresh(context.Background())
	r.mod.refresh(context.Background())
	if *r.otherHit != first || first != 1 {
		t.Errorf("Node ohne Dienst: %d Anfragen insgesamt, erwartet genau 1", *r.otherHit)
	}
}

func TestNoRunningNodeKeepsFeaturesButAnswers503(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true}, user: "bob"}
	r := newRig(t, acc, false)
	r.mod.S.Nodes = fakeNodes{}
	r.mod.refresh(context.Background())
	if len(r.mod.Features()) != 2 || len(r.mod.UI()) != 1 || len(r.mod.Tiles()) != 1 {
		t.Errorf("Rechte/Tab/Kachel bleiben ohne laufenden Dienst bekannt: %d %d %d", len(r.mod.Features()), len(r.mod.UI()), len(r.mod.Tiles()))
	}
	if code, body := r.do(t, "GET", "/api/v1/ext/demo/things", ""); code != 503 {
		t.Errorf("ohne laufenden Dienst 503, war %d %s", code, body)
	}
	// Neustart des Orchestrators bei gestopptem Dienst: der gespeicherte Stand trägt.
	m2 := New(Services{Nodes: fakeNodes{}})
	_ = m2.Mount(muxRoutes{http.NewServeMux()}, module.Deps{Settings: r.settings})
	if len(m2.Features()) != 2 {
		t.Errorf("gespeichertes Manifest nicht geladen: %d", len(m2.Features()))
	}
}

func TestMissingSecretIsAClearFailure(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true}, user: "bob"}
	r := newRig(t, acc, false)
	r.mod.S.Secrets = fakeSecrets{}
	code, body := r.do(t, "GET", "/api/v1/ext/demo/things", "")
	if code != 502 || !strings.Contains(body, "Geheimnis") {
		t.Errorf("%d %s", code, body)
	}
}

func TestMetricsFromRunningService(t *testing.T) {
	r := newRig(t, fakeAccess{}, false)
	var b strings.Builder
	r.mod.WriteMetrics(&b)
	if !strings.Contains(b.String(), "demo_things 3") {
		t.Errorf("Metriken: %q", b.String())
	}
}

func TestLegacyImportRunsOnceAndKeepsOldData(t *testing.T) {
	r := newRig(t, fakeAccess{}, true)
	_ = r.settings.Put("demo.legacy", []byte(`{"channels":[]}`))
	r.mod.importLegacy(context.Background())
	select {
	case got := <-r.imported:
		if got != `{"channels":[]}` {
			t.Errorf("Import-Inhalt: %s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("kein Import")
	}
	r.mod.importLegacy(context.Background())
	select {
	case <-r.imported:
		t.Fatal("Import darf nur einmal laufen")
	default:
	}
	if _, err := r.settings.Get("demo.legacy"); err != nil {
		t.Error("Altdaten bleiben liegen")
	}
	if len(r.audit.log) != 1 || r.audit.log[0].action != "import" {
		t.Errorf("Audit: %+v", r.audit.log)
	}
}

func TestImportSkippedWhenServiceIsNotEmptyOrNothingToImport(t *testing.T) {
	r := newRig(t, fakeAccess{}, false) // Dienst meldet: nicht leer
	_ = r.settings.Put("demo.legacy", []byte(`{}`))
	r.mod.importLegacy(context.Background())
	select {
	case <-r.imported:
		t.Fatal("kein Import in einen nicht leeren Dienst")
	default:
	}
	r2 := newRig(t, fakeAccess{}, true) // leer, aber keine Altdaten
	r2.mod.importLegacy(context.Background())
	select {
	case <-r2.imported:
		t.Fatal("ohne Altdaten nichts zu übernehmen")
	default:
	}
	if _, err := r2.settings.Get(importedPrefix + "demo"); err != nil {
		t.Error("Marker gesetzt, damit später gelöschte Altdaten nie nachträglich importiert werden")
	}
}

func TestBackupIsStoredWhenServiceHasDataAndNeverOverwrittenByAnEmptyService(t *testing.T) {
	r := newRig(t, fakeAccess{}, false) // Dienst hat Daten
	r.mod.backupServices(context.Background())
	got, err := r.settings.Get(backupPrefix + "demo")
	if err != nil || string(got) != `{"stand":1}` {
		t.Fatalf("Sicherungskopie: %q %v", got, err)
	}
	_ = r.settings.Put(backupPrefix+"demo", []byte(`{"alt":true}`))
	empty := newRig(t, fakeAccess{}, true) // leerer Dienst
	_ = empty.settings.Put(backupPrefix+"demo", []byte(`{"alt":true}`))
	empty.mod.backupServices(context.Background())
	if got, _ := empty.settings.Get(backupPrefix + "demo"); string(got) != `{"alt":true}` {
		t.Errorf("ein leerer Dienst darf die Kopie nicht überschreiben: %s", got)
	}
}

func TestEmptyServiceIsRestoredFromBackupEvenAfterTheLegacyImport(t *testing.T) {
	r := newRig(t, fakeAccess{}, true)
	_ = r.settings.Put(importedPrefix+"demo", []byte(`{"done":true}`)) // Altdaten längst übernommen
	_ = r.settings.Put("demo.legacy", []byte(`{"veraltet":true}`))
	_ = r.settings.Put(backupPrefix+"demo", []byte(`{"stand":7}`))
	r.mod.importLegacy(context.Background())
	select {
	case got := <-r.imported:
		if got != `{"stand":7}` {
			t.Errorf("eingespielt wurde %s, erwartet die Sicherungskopie", got)
		}
	case <-time.After(time.Second):
		t.Fatal("keine Wiederherstellung")
	}
	if len(r.audit.log) != 1 || r.audit.log[0].action != "restore" {
		t.Errorf("Audit: %+v", r.audit.log)
	}
}

func TestRelativeBundlesAreServedByTheServiceAndPlatformBundlesStay(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true}, user: "bob"}
	r := newRig(t, acc, false)
	ui, tiles := r.mod.UI(), r.mod.Tiles()
	if len(ui) != 1 || ui[0].Bundle != "/api/v1/ext/demo/_ui/admin.js" {
		t.Errorf("Dienst-Bundle: %+v", ui)
	}
	if len(tiles) != 1 || tiles[0].Bundle != "/dist/modules/demo.js" {
		t.Errorf("Plattform-Bundle bleibt: %+v", tiles)
	}
	// ohne Anmeldung ladbar (import() sendet keinen Header), aber nur Dateien unter ui/
	req, _ := http.NewRequest("GET", getenv(t)+"/api/v1/ext/demo/_ui/admin.js", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "export const x=1;" || !strings.Contains(resp.Header.Get("Content-Type"), "javascript") {
		t.Errorf("Asset: %d %q %q", resp.StatusCode, b, resp.Header.Get("Content-Type"))
	}
	for _, bad := range []string{"/api/v1/ext/demo/_ui/nix.js", "/api/v1/ext/demo/_ui/..%2f..%2fconfig"} {
		resp, _ := http.Get(getenv(t) + bad)
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("%s: %d", bad, resp.StatusCode)
		}
	}
}

func TestContractChecks(t *testing.T) {
	ok := func() Manifest {
		m := testManifest(false)
		m.Kind = "intercom"
		m.Features = []module.FeatureDef{{ID: "demo.use"}}
		m.Routes = []RouteDef{
			{Method: "GET", Path: "/panels", Features: []string{"demo.use"}, Role: "panels"},
			{Method: "GET", Path: "/status", Features: []string{"demo.use"}, Role: "status"},
			{Method: "GET", Path: "/deck/{party}", Features: []string{"demo.use"}, Role: "deck.state"},
			{Method: "POST", Path: "/deck/{party}/command", Features: []string{"demo.use"}, Role: "deck.command"},
		}
		m.Name = "acme-intercom"
		m.Features[0].ID = "acme-intercom.use"
		for i := range m.Routes {
			m.Routes[i].Features = []string{"acme-intercom.use"}
		}
		m.Import, m.Backup = nil, ""
		return m
	}
	if err := ok().Validate(); err != nil {
		t.Fatalf("ein vertragstreues Fremdprodukt muss gültig sein: %v", err)
	}
	cases := map[string]func(*Manifest){
		"Pflichtrolle fehlt": func(m *Manifest) { m.Routes = m.Routes[1:] },
		"falsche Methode":    func(m *Manifest) { m.Routes[0].Method = "POST" },
		"Platzhalter fehlt":  func(m *Manifest) { m.Routes[2].Path = "/deck" },
		"fremde Rolle":       func(m *Manifest) { m.Routes[0].Role = "gibtsnicht" },
		"Rolle doppelt":      func(m *Manifest) { m.Routes[1].Role = "panels" },
		"Rolle ohne Typ":     func(m *Manifest) { m.Kind = "" },
	}
	for name, mutate := range cases {
		m := ok()
		m.Routes = append([]RouteDef(nil), m.Routes...)
		mutate(&m)
		if m.Validate() == nil {
			t.Errorf("%s: Vertragsverletzung nicht erkannt", name)
		}
	}
	m := ok()
	m.Kind = "unbekannter-typ"
	for i := range m.Routes {
		m.Routes[i].Role = ""
	}
	if err := m.Validate(); err != nil {
		t.Errorf("unbekannter Typ ohne Rollen ist ein Dienst ohne Vertrag: %v", err)
	}
}

func TestDiscoveryListsKindAndRolesWithoutProductNames(t *testing.T) {
	acc := fakeAccess{features: map[string]bool{"demo.use": true}, user: "bob"}
	r := newRig(t, acc, false)
	r.mod.mu.Lock()
	mf := r.mod.cached["demo"]
	mf.Kind = "intercom"
	mf.Routes = []RouteDef{
		{Method: "GET", Path: "/panels", Features: []string{"demo.use"}, Role: "panels"},
		{Method: "GET", Path: "/status", Features: []string{"demo.admin"}, Role: "status"},
	}
	r.mod.cached["demo"] = mf
	r.mod.mu.Unlock()
	code, body := r.do(t, "GET", "/api/v1/ext", "")
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var got []Summary
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got) != 1 {
		t.Fatalf("%v %s", err, body)
	}
	s := got[0]
	if s.Kind != "intercom" || !s.Live || s.Roles["panels"].Path != "/panels" {
		t.Errorf("Eintrag: %+v", s)
	}
	if _, has := s.Roles["status"]; has {
		t.Error("Rollen ohne Recht der Person werden nicht angeboten")
	}
}

func TestCheckShapeForTheIntercomContract(t *testing.T) {
	good := map[string]string{
		"panels":     `{"panels":[{"party_id":1,"name":"A","url":"http://x"}]}`,
		"status":     `{"parties":[{"id":1,"name":"A","online":false}],"extra":1}`,
		"deck.state": `{"me":{"id":1,"muted":false,"forced":false},"channels":[],"parties":[]}`,
	}
	for role, body := range good {
		if err := CheckShape("intercom", role, []byte(body)); err != nil {
			t.Errorf("%s: %v", role, err)
		}
	}
	bad := map[string]string{
		"panels":     `{"panels":[{"name":"A"}]}`,
		"status":     `{"parties":[{"id":1}]}`,
		"deck.state": `{"me":{"id":1},"channels":[],"parties":[]}`,
	}
	for role, body := range bad {
		if CheckShape("intercom", role, []byte(body)) == nil {
			t.Errorf("%s: Formfehler nicht erkannt", role)
		}
	}
	if CheckShape("intercom", "panels", []byte(`[]`)) == nil {
		t.Error("kein Objekt")
	}
	if CheckShape("anderer-typ", "panels", []byte(`{}`)) != nil {
		t.Error("Typ ohne Formvorgabe")
	}
}

func TestCheckShapeForGuestRoles(t *testing.T) {
	if err := CheckShape("intercom", "channels", []byte(`{"channels":[{"id":1,"name":"Regie"}]}`)); err != nil {
		t.Error(err)
	}
	if CheckShape("intercom", "channels", []byte(`{"channels":[{"name":"x"}]}`)) == nil {
		t.Error("Kanal ohne id")
	}
	if err := CheckShape("intercom", "guest.create", []byte(`{"id":100000,"url":"https://x/panel?token=t","expires":"2026-10-22T20:00:00Z"}`)); err != nil {
		t.Error(err)
	}
	if CheckShape("intercom", "guest.create", []byte(`{"id":1}`)) == nil {
		t.Error("Gast ohne url")
	}
}

package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mxldomains"
)

// memDomains ist ein Domain-Speicher im Arbeitsspeicher (Pfadlogik wie mxldomains.Store, ohne Datenbank).
type memDomains struct {
	base  string
	known map[string]bool
}

func newMemDomains(t *testing.T, names ...string) *memDomains {
	m := &memDomains{base: filepath.Join(t.TempDir(), "omp-mxl"), known: map[string]bool{}}
	for _, n := range names {
		m.known[n] = true
	}
	return m
}
func (m *memDomains) PathFor(n string) string {
	if n == "" || n == mxldomains.DefaultName {
		return m.base
	}
	return m.base + "-" + n
}
func (m *memDomains) List() ([]mxldomains.Domain, error) {
	out := []mxldomains.Domain{{Name: "default", Path: m.base, Default: true}}
	for n := range m.known {
		out = append(out, mxldomains.Domain{Name: n, Path: m.PathFor(n)})
	}
	return out, nil
}
func (m *memDomains) Resolve(n string) (string, error) {
	if n == "" || n == mxldomains.DefaultName {
		return m.base, nil
	}
	if err := mxldomains.ValidateName(n); err != nil {
		return "", err
	}
	if !m.known[n] {
		return "", mxldomains.ErrNotFound
	}
	return m.PathFor(n), nil
}
func (m *memDomains) NameForPath(p string) string {
	p = strings.TrimRight(p, "/")
	if p == "" || p == m.base {
		return "default"
	}
	return strings.TrimPrefix(p, m.base+"-")
}
func (m *memDomains) Create(n, d, by string) (mxldomains.Domain, error) {
	m.known[n] = true
	return mxldomains.Domain{Name: n, Path: m.PathFor(n)}, nil
}
func (m *memDomains) Delete(n string) error { delete(m.known, n); return nil }

// capturingLauncher merkt sich das Env des Starts.
type capturingLauncher struct {
	fakeLauncherService
	env map[string]string
}

func (c *capturingLauncher) StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error) {
	c.env = extraEnv
	return c.started, c.startErr
}

func postInstance(t *testing.T, l LauncherService, ds MXLDomainStore, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handlePostInstance(l, nil, nil, func(string) bool { return false }, ds)(rec, req)
	return rec
}

func TestPostInstanceWithDomain(t *testing.T) {
	ds := newMemDomains(t, "test")
	cl := &capturingLauncher{fakeLauncherService: fakeLauncherService{
		catalog: []launcher.CatalogEntry{{Type: "omp-source"}, {Type: "box", Runner: "podman"}},
		started: launcher.Instance{ID: "i1", Type: "omp-source"},
	}}

	if rec := postInstance(t, cl, ds, `{"type":"omp-source","domain":"test"}`); rec.Code != http.StatusOK {
		t.Fatalf("known domain: %d %s", rec.Code, rec.Body)
	}
	if got := cl.env["OMP_MXL_DOMAIN_NAME"]; got != "test" || cl.env["OMP_MXL_DOMAIN"] != "" {
		t.Fatalf("env = %v (nur der Name, nie ein Pfad)", cl.env)
	}

	cl.env = nil
	if rec := postInstance(t, cl, ds, `{"type":"omp-source"}`); rec.Code != http.StatusOK || cl.env != nil {
		t.Fatalf("ohne Domain muss alles beim Alten bleiben: %d env=%v", rec.Code, cl.env)
	}
	if rec := postInstance(t, cl, ds, `{"type":"omp-source","domain":"default"}`); rec.Code != http.StatusOK || cl.env != nil {
		t.Fatalf("default: %d env=%v", rec.Code, cl.env)
	}
	if rec := postInstance(t, cl, ds, `{"type":"omp-source","domain":"nope"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unbekannte Domain: %d", rec.Code)
	}
	// entfernte Hosts und Container-Nodes: der Name reist mit, den Pfad leitet der Zielort ab
	cl.env = nil
	if rec := postInstance(t, cl, ds, `{"type":"omp-source","domain":"test","hostId":"h1"}`); rec.Code != http.StatusOK || cl.env["OMP_MXL_DOMAIN_NAME"] != "test" {
		t.Fatalf("entfernter Host: %d env=%v", rec.Code, cl.env)
	}
	cl.env = nil
	if rec := postInstance(t, cl, ds, `{"type":"box","domain":"test"}`); rec.Code != http.StatusOK || cl.env["OMP_MXL_DOMAIN_NAME"] != "test" {
		t.Fatalf("Container-Node: %d env=%v", rec.Code, cl.env)
	}
	if rec := postInstance(t, cl, nil, `{"type":"omp-source","domain":"test"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("ohne Domain-Verwaltung: %d", rec.Code)
	}
}

func TestSameMXLDomain(t *testing.T) {
	ls := fakeLauncherService{instances: []launcher.Instance{
		{ID: "a", ExtraEnv: map[string]string{"OMP_MXL_DOMAIN_NAME": "test"}},
		{ID: "b", ExtraEnv: map[string]string{"OMP_MXL_DOMAIN_NAME": "test"}},
		{ID: "c"},
	}}
	g := graph.Graph{Nodes: []graph.Node{
		{ID: "na", InstanceID: "a", Outputs: []graph.Port{{ID: "sa"}}, Inputs: []graph.Port{{ID: "ra"}}},
		{ID: "nb", InstanceID: "b", Outputs: []graph.Port{{ID: "sb"}}, Inputs: []graph.Port{{ID: "rb"}}},
		{ID: "nc", InstanceID: "c", Outputs: []graph.Port{{ID: "sc"}}, Inputs: []graph.Port{{ID: "rc"}}},
		{ID: "nx", Outputs: []graph.Port{{ID: "sx"}}, Inputs: []graph.Port{{ID: "rx"}}}, // nicht vom Launcher
	}}
	if err := sameMXLDomain(g, ls, "sa", "rb"); err != nil {
		t.Errorf("gleiche Domain (auch mit Schrägstrich): %v", err)
	}
	if err := sameMXLDomain(g, ls, "sa", "rc"); err == nil || !strings.Contains(err.Error(), "test / default") {
		t.Errorf("test -> default muss abgelehnt werden: %v", err)
	}
	if err := sameMXLDomain(g, ls, "sc", "ra"); err == nil {
		t.Errorf("default -> test muss abgelehnt werden")
	}
	if err := sameMXLDomain(g, ls, "sc", "rx"); err != nil {
		t.Errorf("Standarddomain zu fremdem Node: %v", err)
	}
	if err := sameMXLDomain(g, ls, "unbekannt", "rc"); err != nil {
		t.Errorf("unbekannte Ports ändern nichts: %v", err)
	}
	if err := sameMXLDomain(g, nil, "sa", "rc"); err != nil {
		t.Errorf("ohne Launcher keine Prüfung: %v", err)
	}
}

func TestDeleteMXLDomain(t *testing.T) {
	ds := newMemDomains(t, "test", "frei")
	if err := os.MkdirAll(ds.PathFor("test"), 0o755); err != nil {
		t.Fatal(err)
	}
	ls := fakeLauncherService{instances: []launcher.Instance{
		{ID: "a", Label: "Quelle", ExtraEnv: map[string]string{"OMP_MXL_DOMAIN_NAME": "test"}},
	}}
	del := func(name string) int {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/mxl/domains/"+name, nil)
		req.SetPathValue("name", name)
		rec := httptest.NewRecorder()
		handleDeleteMXLDomain(ds, ls, nil)(rec, req)
		return rec.Code
	}
	if c := del("test"); c != http.StatusConflict {
		t.Errorf("Domain mit Instanz: %d", c)
	}
	if !ds.known["test"] {
		t.Error("Domain mit Instanz darf nicht gelöscht sein")
	}
	if c := del("default"); c != http.StatusBadRequest {
		t.Errorf("default: %d", c)
	}
	if c := del("../x"); c != http.StatusBadRequest {
		t.Errorf("ungültiger Name: %d", c)
	}
	if c := del("nope"); c != http.StatusNotFound {
		t.Errorf("unbekannt: %d", c)
	}
	if c := del("frei"); c != http.StatusOK || ds.known["frei"] {
		t.Errorf("freie Domain: %d", c)
	}
}

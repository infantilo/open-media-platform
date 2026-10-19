package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// featureAuthz erweitert den Test-Rechte-Speicher um Funktionsrechte (Kapitel 44).
type featureAuthz struct {
	fakeAuthzSvc
	patterns []string
	all      bool
	groups   []string
	grants   []authz.FeatureGrant
}

func (f *featureAuthz) HasFeature(_, feature string) (bool, error) {
	if f.all {
		return true, nil
	}
	for _, p := range f.patterns {
		if authz.FeatureMatches(p, feature) {
			return true, nil
		}
	}
	return false, nil
}
func (f *featureAuthz) FeaturePatterns(string) ([]string, bool, error) { return f.patterns, f.all, nil }
func (f *featureAuthz) GroupsOf(string) ([]string, error)              { return f.groups, nil }
func (f *featureAuthz) ListFeatureGrants() ([]authz.FeatureGrant, error) {
	return f.grants, nil
}
func (f *featureAuthz) CreateFeatureGrant(st, subj, feat, by string) (authz.FeatureGrant, error) {
	if feat == "" {
		return authz.FeatureGrant{}, authz.ErrFeatureValidation
	}
	g := authz.FeatureGrant{ID: "g1", SubjectType: st, Subject: subj, Feature: feat, CreatedBy: by}
	f.grants = append(f.grants, g)
	return g, nil
}
func (f *featureAuthz) DeleteFeatureGrant(id string) error {
	if id != "g1" {
		return authz.ErrFeatureNotFound
	}
	return nil
}
func (f *featureAuthz) DeleteFeatureGrantsBySubject(string, string) error { return nil }

func featureGate(az AuthzChecker, users int) *authGate {
	return &authGate{auth: fakeAuthSvc{userCount: users, principal: auth.Principal{UserID: "u1", Username: "alice"}}, authz: az, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}
}

func TestRequireFeatureAllowsGrantedDeniesOthersAndBootstrapIsOpen(t *testing.T) {
	cases := []struct {
		name  string
		az    *featureAuthz
		users int
		want  int
	}{
		{"exakt vergeben", &featureAuthz{patterns: []string{"ingest.schedule.create"}}, 1, 200},
		{"Muster modul.*", &featureAuthz{patterns: []string{"ingest.*"}}, 1, 200},
		{"anderes Recht", &featureAuthz{patterns: []string{"review.work"}}, 1, 403},
		{"keine Vergabe", &featureAuthz{}, 1, 403},
		{"configure global", &featureAuthz{all: true}, 1, 200},
		{"Bootstrap offen", &featureAuthz{}, 0, 200},
	}
	for _, c := range cases {
		mux := http.NewServeMux()
		moduleRoutes{mux: mux, g: featureGate(c.az, c.users)}.Handle("POST /m", module.Feature("ingest.schedule.create"), okHandler)
		req := httptest.NewRequest(http.MethodPost, "/m", nil)
		req.Header.Set("Authorization", "Bearer valid")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", c.name, rec.Code, c.want, strings.TrimSpace(rec.Body.String()))
		}
	}
	// Ohne Token: 401, nie 403
	mux := http.NewServeMux()
	moduleRoutes{mux: mux, g: featureGate(&featureAuthz{all: true}, 1)}.Handle("POST /m", module.Feature("x.y"), okHandler)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/m", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("ohne Token: %d", rec.Code)
	}
}

func TestFeatureGrantAdminHandlers(t *testing.T) {
	az := &featureAuthz{}
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req = req.WithContext(contextWithPrincipal(context.Background(), auth.Principal{Username: "root"}))
		rec := httptest.NewRecorder()
		handleCreateFeatureGrant(az, nil)(rec, req)
		return rec
	}
	if rec := post(`{"subjectType":"user","subject":"bob","feature":"review.work"}`); rec.Code != 201 || !strings.Contains(rec.Body.String(), `"createdBy":"root"`) {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := post(`{"subject":"bob","feature":""}`); rec.Code != 400 {
		t.Fatalf("ungültig: %d", rec.Code)
	}
	if rec := post(`kaputt`); rec.Code != 400 {
		t.Fatalf("kein JSON: %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	handleListFeatureGrants(az)(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	var list []authz.FeatureGrant
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 1 {
		t.Fatalf("list: %v %s", err, rec.Body)
	}
	del := func(id string) int {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		handleDeleteFeatureGrant(az, nil)(rec, req)
		return rec.Code
	}
	if c := del("g1"); c != 204 {
		t.Errorf("delete: %d", c)
	}
	if c := del("nope"); c != 404 {
		t.Errorf("delete unbekannt: %d", c)
	}
}

type taskModule struct{ name string }

func (m taskModule) Name() string                           { return m.name }
func (m taskModule) Mount(module.Routes, module.Deps) error { return nil }
func (m taskModule) Tasks(_ context.Context, who module.Identity) ([]module.Task, error) {
	return []module.Task{{ID: "1", Kind: "qc", Title: "für " + who.User, Mine: true}}, nil
}

func TestMeTasksAndMeFeatures(t *testing.T) {
	reg := module.NewRegistry()
	_ = reg.Register(taskModule{name: "t"})
	reg.Mount(moduleRoutes{mux: http.NewServeMux(), g: featureGate(&featureAuthz{}, 1)}, module.Deps{})
	az := &featureAuthz{groups: []string{"g"}, patterns: []string{"review.*"}}
	req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(contextWithPrincipal(context.Background(), auth.Principal{Username: "alice"}))
	rec := httptest.NewRecorder()
	handleMeTasks(reg, az)(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"module":"t"`) || !strings.Contains(rec.Body.String(), "für alice") {
		t.Fatalf("tasks: %d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	handleMeFeatures(az)(rec, req)
	if !strings.Contains(rec.Body.String(), `"patterns":["review.*"]`) || !strings.Contains(rec.Body.String(), `"all":false`) {
		t.Fatalf("features: %s", rec.Body)
	}
	// Bootstrap (kein Nutzer im Kontext): alles erlaubt
	rec = httptest.NewRecorder()
	handleMeFeatures(az)(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), `"all":true`) {
		t.Fatalf("bootstrap: %s", rec.Body)
	}
	// Katalog ohne Registry
	rec = httptest.NewRecorder()
	handleListFeatures(nil)(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("katalog: %s", rec.Body)
	}
}

type dirAuth struct{ fakeAuthSvc }

func (dirAuth) ListUsers(context.Context) ([]auth.User, error) {
	return []auth.User{{Username: "anna"}, {Username: "bob"}}, nil
}

func TestDirectoryNeedsAFeatureRight(t *testing.T) {
	withCtx := func(name string) *http.Request {
		return httptest.NewRequest(http.MethodGet, "/", nil).WithContext(contextWithPrincipal(context.Background(), auth.Principal{Username: name}))
	}
	call := func(az *featureAuthz, req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handleDirectory(dirAuth{}, nil, az)(rec, req)
		return rec
	}
	if rec := call(&featureAuthz{}, withCtx("x")); rec.Code != 403 {
		t.Errorf("ohne Recht: %d", rec.Code)
	}
	rec := call(&featureAuthz{patterns: []string{"review.work"}}, withCtx("x"))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"username":"anna"`) || !strings.Contains(rec.Body.String(), `"groups":[]`) {
		t.Errorf("mit Recht: %d %s", rec.Code, rec.Body)
	}
	if rec := call(&featureAuthz{all: true}, withCtx("x")); rec.Code != 200 {
		t.Errorf("configure: %d", rec.Code)
	}
	if rec := call(&featureAuthz{}, httptest.NewRequest(http.MethodGet, "/", nil)); rec.Code != 200 {
		t.Errorf("Bootstrap: %d", rec.Code)
	}
}

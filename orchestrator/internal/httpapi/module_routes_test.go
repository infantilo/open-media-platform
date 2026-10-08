package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Die Modul-Anbindung muss exakt dieselbe Rechteprüfung ergeben wie die direkte Verdrahtung im Kern: gleiche Anfragen
// (ohne/ungültiges/gültiges Token, mit und ohne Nutzer im System) → gleiche Statuscodes.
func TestModuleRoutesEnforceTheSameAuthAsCoreRoutes(t *testing.T) {
	gates := map[string]*authGate{
		"bootstrap (keine Nutzer)": {auth: fakeAuthSvc{userCount: 0}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}},
		"ohne Token":               {auth: fakeAuthSvc{userCount: 1}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}},
		"ungültiges Token":         {auth: fakeAuthSvc{userCount: 1, authenticateErr: auth.ErrTokenInvalid}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}},
		"gültiges Token":           {auth: fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "alice"}}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}},
	}
	cases := []struct {
		name string
		auth module.Auth
		core func(g *authGate) http.HandlerFunc
	}{
		{"authenticated", module.Authenticated(), func(g *authGate) http.HandlerFunc { return g.requireAuth(okHandler) }},
		{"verb admin", module.Verb(authz.VerbAdmin), func(g *authGate) http.HandlerFunc { return g.requireVerbGlobal(authz.VerbAdmin, okHandler) }},
		{"verb configure", module.Verb(authz.VerbConfigure), func(g *authGate) http.HandlerFunc { return g.requireVerbGlobal(authz.VerbConfigure, okHandler) }},
		{"verb on node", module.VerbOnNode(authz.VerbOperate), func(g *authGate) http.HandlerFunc { return g.requireVerbOnNode(authz.VerbOperate, okHandler) }},
	}
	for gname, g := range gates {
		for _, c := range cases {
			mux := http.NewServeMux()
			moduleRoutes{mux: mux, g: g}.Handle("GET /m/{id}", c.auth, okHandler)
			for _, token := range []string{"", "Bearer bogus", "Bearer valid"} {
				req := httptest.NewRequest(http.MethodGet, "/m/n1", nil)
				if token != "" {
					req.Header.Set("Authorization", token)
				}
				via := httptest.NewRecorder()
				mux.ServeHTTP(via, req)
				direct := httptest.NewRecorder()
				req2 := httptest.NewRequest(http.MethodGet, "/m/n1", nil)
				req2.SetPathValue("id", "n1")
				if token != "" {
					req2.Header.Set("Authorization", token)
				}
				c.core(g)(direct, req2)
				if via.Code != direct.Code {
					t.Errorf("%s / %s / token=%q: module route %d, core route %d", gname, c.name, token, via.Code, direct.Code)
				}
			}
		}
	}
}

func TestModuleRoutesAnonymousIsOpenAndUnknownKindIsNotOpen(t *testing.T) {
	g := &authGate{auth: fakeAuthSvc{userCount: 1}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}
	mux := http.NewServeMux()
	r := moduleRoutes{mux: mux, g: g}
	r.Handle("GET /open", module.Anonymous(), okHandler)
	r.Handle("GET /weird", module.Auth{Kind: module.AuthKind(99)}, okHandler)
	for path, want := range map[string]int{"/open": http.StatusOK, "/weird": http.StatusUnauthorized} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", path, rec.Code, want)
		}
	}
}

func TestHandleModulesListsStateAndUIOfMountedModules(t *testing.T) {
	reg := module.NewRegistry("off")
	_ = reg.Register(uiModule{name: "shown"})
	_ = reg.Register(uiModule{name: "off"})
	reg.Mount(moduleRoutes{mux: http.NewServeMux(), g: &authGate{auth: fakeAuthSvc{}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}}, module.Deps{})
	rec := httptest.NewRecorder()
	handleModules(reg)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/modules", nil))
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `"name":"shown","state":"mounted"`) || !strings.Contains(body, `"element":"x-shown"`) {
		t.Fatalf("%d %s", rec.Code, body)
	}
	if !strings.Contains(body, `"name":"off","state":"disabled"`) || strings.Contains(body, "x-off") {
		t.Fatalf("a disabled module is listed but contributes no UI: %s", body)
	}
	rec = httptest.NewRecorder()
	handleModules(nil)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/modules", nil))
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("no registry → empty list, got %s", rec.Body.String())
	}
}

type uiModule struct{ name string }

func (m uiModule) Name() string                           { return m.name }
func (m uiModule) Mount(module.Routes, module.Deps) error { return nil }
func (m uiModule) UI() []module.UITab {
	return []module.UITab{{ID: "t", Placement: "main", Label: map[string]string{"de": "T"}, Element: "x-" + m.name, Bundle: "/b.js"}}
}

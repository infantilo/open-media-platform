package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
)

func cookieGate() *authGate {
	return &authGate{auth: fakeAuthSvc{userCount: 1, principal: auth.Principal{Username: "anna"}}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}
}

func withCookie(method, path string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "tok"})
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func serve(g *authGate, r *http.Request) int {
	rec := httptest.NewRecorder()
	g.requireAuth(okHandler)(rec, r)
	return rec.Code
}

// Audit H1: das Cookie authentifiziert, aber nur zulässige Anfragen (CSRF-Schutz).
func TestSessionCookieAuthenticatesSameOriginRequests(t *testing.T) {
	g := cookieGate()
	if c := serve(g, withCookie(http.MethodGet, "/api/v1/x", nil)); c != http.StatusOK {
		t.Fatalf("GET mit Cookie: %d", c)
	}
	if c := serve(g, withCookie(http.MethodPost, "/api/v1/x", map[string]string{"Origin": "http://example.com"})); c != http.StatusOK {
		t.Fatalf("POST gleicher Ursprung (Host example.com): %d", c)
	}
	if c := serve(g, withCookie(http.MethodPost, "/api/v1/x", nil)); c != http.StatusOK {
		t.Fatalf("POST ohne Browser-Header: %d", c)
	}
	for name, h := range map[string]map[string]string{
		"fremder Origin":  {"Origin": "https://evil.example"},
		"Origin null":     {"Origin": "null"},
		"Sec-Fetch cross": {"Sec-Fetch-Site": "cross-site"},
		"Sec-Fetch site":  {"Sec-Fetch-Site": "same-site"},
	} {
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			if c := serve(g, withCookie(m, "/api/v1/x", h)); c != http.StatusUnauthorized {
				t.Errorf("%s %s: %d, want 401", m, name, c)
			}
		}
	}
	if c := serve(g, withCookie(http.MethodPost, "/api/v1/x", map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "http://example.com"})); c != http.StatusOK {
		t.Fatalf("same-origin: %d", c)
	}
}

func TestBearerStillWorksFromAnyOriginAndNoCookieIsUnauthenticated(t *testing.T) {
	g := cookieGate()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/x", nil)
	r.Header.Set("Authorization", "Bearer abc")
	r.Header.Set("Origin", "https://tool.example")
	if c := serve(g, r); c != http.StatusOK {
		t.Fatalf("Bearer mit fremdem Origin: %d", c)
	}
	if c := serve(g, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil)); c != http.StatusUnauthorized {
		t.Fatalf("ohne alles: %d", c)
	}
}

func TestLoginSetsHardenedCookieAndSessionExchange(t *testing.T) {
	lockout := auth.NewLoginLockout()
	h := handleLogin(fakeAuthSvc{loginToken: "jwt-1"}, &fakeAuditSvc{}, lockout)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"a","password":"b"}`))
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	h(rec, req)
	var c *http.Cookie
	for _, x := range rec.Result().Cookies() {
		if x.Name == sessionCookieName {
			c = x
		}
	}
	if c == nil || c.Value != "jwt-1" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("%+v", c)
	}

	// Austausch: nur mit Bearer-Header, nicht allein mit Cookie.
	ex := handleSession(fakeAuthSvc{})
	rec = httptest.NewRecorder()
	ex(rec, withCookie(http.MethodPost, "/api/v1/auth/session", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Cookie allein: %d", rec.Code)
	}
	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/auth/session", nil)
	r2.Header.Set("Authorization", "Bearer old")
	rec = httptest.NewRecorder()
	ex(rec, r2)
	if rec.Code != http.StatusNoContent || len(rec.Result().Cookies()) != 1 || rec.Result().Cookies()[0].Value != "old" {
		t.Fatalf("%d %v", rec.Code, rec.Result().Cookies())
	}
	rec = httptest.NewRecorder()
	handleSession(fakeAuthSvc{authenticateErr: errors.New("ungültig")})(rec, r2)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("ungültiges Token: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleLogout()(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil))
	if cs := rec.Result().Cookies(); len(cs) != 1 || cs[0].MaxAge >= 0 {
		t.Fatalf("Logout löscht das Cookie: %v", cs)
	}
}

func TestShellSecurityHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	withShellSecurityHeaders("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "script-src 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP ohne %q: %s", want, csp)
		}
	}
	if strings.Contains(csp, "unsafe-eval") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("Skripte nicht aufweichen: %s", csp)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("nosniff")
	}
}

func TestShellCSPAllowsFramesOnlyFromTheUIOrigin(t *testing.T) {
	rec := httptest.NewRecorder()
	withShellSecurityHeaders("8001", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://studio.lan:8000/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-src 'self' http://studio.lan:8001 https://studio.lan:8001") || strings.Contains(csp, "frame-src *") {
		t.Fatal(csp)
	}
	rec = httptest.NewRecorder()
	withShellSecurityHeaders("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-src") {
		t.Fatal("ohne Isolation kein frame-src (default-src 'self' gilt)")
	}
}

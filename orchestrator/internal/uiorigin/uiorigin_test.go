package uiorigin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type seen struct {
	auth, cookie, origin, path string
	n                          int
}

func rig(t *testing.T) (*Manager, http.Handler, *seen) {
	t.Helper()
	m := NewManager()
	s := &seen{}
	main := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.auth, s.cookie, s.origin, s.path = r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.Header.Get("Origin"), r.URL.Path
		s.n++
		w.WriteHeader(200)
	})
	return m, m.Handler(Config{Main: main, ExtraPaths: []string{"/api/v1/events"}, HostJS: []byte("//js"), DesignTokens: []byte("/*css*/")}), s
}

func enter(t *testing.T, h http.Handler, node, g string) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://ui.example:8001/enter/"+node+"?g="+g, nil))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("enter: %d %s", rec.Code, rec.Body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookiePref+node {
			if !c.HttpOnly || c.Path != "/" {
				t.Fatalf("Cookie nicht gehärtet: %+v", c)
			}
			return c
		}
	}
	t.Fatal("Cookie fehlt")
	return nil
}

func call(h http.Handler, method, path string, c *http.Cookie, hdr map[string]string) int {
	r := httptest.NewRequest(method, "http://ui.example:8001"+path, nil)
	if c != nil {
		r.AddCookie(c)
	}
	for k, v := range hdr {
		if k == "Cookie" {
			r.AddCookie(&http.Cookie{Name: "omp_session", Value: v})
			continue
		}
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func TestGrantIsSingleUseAndBoundToNode(t *testing.T) {
	m, h, _ := rig(t)
	g, ok := m.NewGrant("n1", "jwt")
	if !ok {
		t.Fatal("grant")
	}
	enter(t, h, "n1", g)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/enter/n1?g="+g, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("zweites Einlösen: %d", rec.Code)
	}
	g2, _ := m.NewGrant("n1", "jwt")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/enter/n2?g="+g2, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("Grant für anderen Node: %d", rec.Code)
	}
	if _, ok := m.NewGrant("../x", "jwt"); ok {
		t.Fatal("ungültige Node-ID")
	}
	if _, ok := m.NewGrant("n1", ""); ok {
		t.Fatal("ohne Token")
	}
}

func TestGrantExpires(t *testing.T) {
	m, h, _ := rig(t)
	now := time.Unix(1000, 0)
	m.now = func() time.Time { return now }
	g, _ := m.NewGrant("n1", "jwt")
	now = now.Add(grantTTL + time.Second)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/enter/n1?g="+g, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("abgelaufen: %d", rec.Code)
	}
}

func TestProxyScopesToOwnNodeAndInjectsTokenServerSide(t *testing.T) {
	m, h, s := rig(t)
	g, _ := m.NewGrant("n1", "the-user-jwt")
	c := enter(t, h, "n1", g)
	if code := call(h, "GET", "/api/v1/nodes/n1/params/x", c, map[string]string{"Cookie": "stolen"}); code != 200 || s.auth != "Bearer the-user-jwt" {
		t.Fatalf("eigener Node: %d auth=%q", code, s.auth)
	}
	if strings.Contains(s.cookie, "omp_session") || strings.Contains(s.cookie, cookiePref) {
		t.Fatalf("Cookies dürfen nicht an den Orchestrator gehen: %q", s.cookie)
	}
	before := s.n
	for name, path := range map[string]string{
		"anderer Node":   "/api/v1/nodes/n2/params/x",
		"Administration": "/api/v1/admin/settings/nodes",
		"Instanzen":      "/api/v1/instances",
		"Graph":          "/api/v1/graph",
		"Traversal":      "/api/v1/nodes/../admin/users",
	} {
		code := call(h, "GET", path, c, nil)
		// Der Router säubert „..“ per Umleitung auf den bereinigten Pfad; der wird oben mit 403 abgewiesen — nie weitergereicht.
		if code != http.StatusForbidden && !(name == "Traversal" && code == http.StatusTemporaryRedirect) {
			t.Errorf("%s: %d, want 403", name, code)
		}
	}
	if s.n != before {
		t.Fatal("abgewiesene Anfragen dürfen den Orchestrator nicht erreichen")
	}
	if code := call(h, "GET", "/api/v1/nodes/n1/params/x", nil, nil); code != http.StatusForbidden {
		t.Fatalf("ohne Sitzung: %d", code)
	}
}

func TestExtraPathsAreGetOnlyAndNeedASession(t *testing.T) {
	m, h, _ := rig(t)
	g, _ := m.NewGrant("n1", "jwt")
	c := enter(t, h, "n1", g)
	if code := call(h, "GET", "/api/v1/events", c, nil); code != 200 {
		t.Fatalf("Ereignisstrom: %d", code)
	}
	if code := call(h, "POST", "/api/v1/events", c, nil); code != http.StatusForbidden {
		t.Fatalf("POST auf freigegebenen Pfad: %d", code)
	}
	if code := call(h, "GET", "/api/v1/events", nil, nil); code != http.StatusForbidden {
		t.Fatalf("ohne Sitzung: %d", code)
	}
}

func TestUnsafeRequestsMustComeFromOwnOrigin(t *testing.T) {
	m, h, _ := rig(t)
	g, _ := m.NewGrant("n1", "jwt")
	c := enter(t, h, "n1", g)
	if code := call(h, "POST", "/api/v1/nodes/n1/methods/x", c, map[string]string{"Origin": "http://evil.example"}); code != http.StatusForbidden {
		t.Fatalf("fremder Origin: %d", code)
	}
	if code := call(h, "POST", "/api/v1/nodes/n1/methods/x", c, map[string]string{"Sec-Fetch-Site": "cross-site"}); code != http.StatusForbidden {
		t.Fatalf("cross-site: %d", code)
	}
	if code := call(h, "POST", "/api/v1/nodes/n1/methods/x", c, map[string]string{"Origin": "http://ui.example:8001", "Sec-Fetch-Site": "same-origin"}); code != 200 {
		t.Fatalf("eigener Ursprung: %d", code)
	}
}

func TestHostPageNeedsSessionAndFramesOnlyFromSameHost(t *testing.T) {
	m, h, _ := rig(t)
	if code := call(h, "GET", "/ui/n1", nil, nil); code != http.StatusForbidden {
		t.Fatalf("ohne Sitzung: %d", code)
	}
	g, _ := m.NewGrant("n1", "jwt")
	c := enter(t, h, "n1", g)
	r := httptest.NewRequest("GET", "http://ui.example:8001/ui/n1", nil)
	r.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	csp := rec.Header().Get("Content-Security-Policy")
	if rec.Code != 200 || !strings.Contains(csp, "frame-ancestors http://ui.example:* https://ui.example:*") || !strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("%d %s", rec.Code, csp)
	}
}

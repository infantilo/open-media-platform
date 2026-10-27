package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/supportaccess"
)

// fakeSupport: ein Speicher im Arbeitsspeicher mit einem bekannten Token.
type fakeSupport struct {
	grants map[string]supportaccess.Grant // Token → Zugang
	logins int
}

func newFakeSupport() *fakeSupport {
	now := time.Now()
	return &fakeSupport{grants: map[string]supportaccess.Grant{
		supportaccess.TokenPrefix + "ok.secret":      {ID: "ok", CreatedBy: "anna", Note: "Ticket 1", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		supportaccess.TokenPrefix + "old.secret":     {ID: "old", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)},
		supportaccess.TokenPrefix + "revoked.secret": {ID: "revoked", CreatedAt: now, ExpiresAt: now.Add(time.Hour), RevokedAt: &now},
	}}
}
func (f *fakeSupport) Verify(_ context.Context, token string) (supportaccess.Grant, error) {
	g, ok := f.grants[token]
	switch {
	case !ok:
		return supportaccess.Grant{}, supportaccess.ErrInvalid
	case g.RevokedAt != nil:
		return g, supportaccess.ErrRevoked
	case !time.Now().Before(g.ExpiresAt):
		return g, supportaccess.ErrExpired
	}
	return g, nil
}
func (f *fakeSupport) Touch(context.Context, string) {}
func (f *fakeSupport) Create(_ context.Context, by, note string, d time.Duration) (supportaccess.Grant, string, error) {
	if d < supportaccess.MinDuration || d > supportaccess.MaxDuration {
		return supportaccess.Grant{}, "", supportaccess.ErrBadTime
	}
	g := supportaccess.Grant{ID: "neu", CreatedBy: by, Note: note, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(d)}
	tok := supportaccess.TokenPrefix + "neu.geheim"
	f.grants[tok] = g
	return g, tok, nil
}
func (f *fakeSupport) List(context.Context, int) ([]supportaccess.Grant, error) {
	var out []supportaccess.Grant
	for _, g := range f.grants {
		out = append(out, g)
	}
	return out, nil
}
func (f *fakeSupport) Revoke(_ context.Context, id string) error {
	for tok, g := range f.grants {
		if g.ID == id {
			now := time.Now()
			g.RevokedAt = &now
			f.grants[tok] = g
			return nil
		}
	}
	return supportaccess.ErrUnknown
}
func (f *fakeSupport) MarkLogin(context.Context, string) error { f.logins++; return nil }

type fakeLimiter struct{ failures int }

func (l *fakeLimiter) Locked(string) bool   { return l.failures >= 3 }
func (l *fakeLimiter) RecordFailure(string) { l.failures++ }
func (l *fakeLimiter) RecordSuccess(string) { l.failures = 0 }

type recDomainAudit struct{ calls []string }

func (r *recDomainAudit) Log(actor, objType, objID, action string, _ map[string]any) {
	r.calls = append(r.calls, actor+"|"+objType+"|"+objID+"|"+action)
}

func TestSupportMayRead(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/v1/admin/selftest", true},
		{"GET", "/api/v1/admin/support-bundle", true},
		{"GET", "/api/v1/timeline", true},
		{"GET", "/api/v1/nodes/abc/diagnosis", true},
		{"GET", "/api/v1/nodes/abc/diag/pipelines", true},
		{"GET", "/api/v1/hosts/h1/metrics/history", true},
		{"GET", "/api/v1/logs", true},
		// nie: Nutzer, Rechte, Einstellungen, Sicherungen, Zugangsverwaltung
		{"GET", "/api/v1/auth/users", false},
		{"GET", "/api/v1/admin/role-bindings", false},
		{"GET", "/api/v1/admin/settings/system", false},
		{"GET", "/api/v1/admin/backups", false},
		{"GET", "/api/v1/admin/support-access", false},
		{"GET", "/api/v1/admin/audit-log", false},
		{"GET", "/api/v1/nodes/abc/params/x", false},
		{"GET", "/api/v1/nodes/a/b/diagnosis", false},
		// nie schreiben
		{"POST", "/api/v1/instances", false},
		{"POST", "/api/v1/timeline/marker", false},
		{"DELETE", "/api/v1/instances/x", false},
		{"PUT", "/api/v1/layouts/x", false},
		{"POST", "/api/v1/admin/selftest", false},
	} {
		if got := supportMayRead(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s = %v, erwartet %v", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestSupportReadOnlyMiddlewareBlocksWritesAndAuditsThem(t *testing.T) {
	aud := &fakeAuditSvc{}
	g := &authGate{auth: fakeAuthSvc{userCount: 1}, authz: fakeAuthzSvc{}, audit: aud, nodes: fakeNodeLister{}, support: newFakeSupport()}
	reached := 0
	h := supportReadOnly(g, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++; w.WriteHeader(200) }))
	do := func(method, path, token string) int {
		req := httptest.NewRequest(method, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	tok := supportaccess.TokenPrefix + "ok.secret"
	if c := do("GET", "/api/v1/timeline", tok); c != 200 {
		t.Errorf("Lesen: %d", c)
	}
	if c := do("POST", "/api/v1/instances", tok); c != http.StatusForbidden {
		t.Errorf("Schreiben: %d", c)
	}
	if c := do("GET", "/api/v1/auth/users", tok); c != http.StatusForbidden {
		t.Errorf("Nutzerliste: %d", c)
	}
	if c := do("GET", "/api/v1/admin/support-bundle", tok); c != 200 {
		t.Errorf("Paket: %d", c)
	}
	// Normale Nutzer und fremde Token laufen unverändert weiter
	if c := do("POST", "/api/v1/instances", "jwt.token.x"); c != 200 {
		t.Errorf("Nutzer-Token wird nicht eingeschränkt: %d", c)
	}
	if c := do("GET", "/index.html", tok); c != 200 {
		t.Errorf("außerhalb von /api/: %d", c)
	}
	// Abgelaufen/widerrufen: die Middleware lässt durch, die normale Prüfung antwortet 401 (hier der Dummy)
	if reached != 4 {
		t.Errorf("erreichte Anfragen: %d", reached)
	}
	var logged []string
	for _, c := range aud.logged {
		logged = append(logged, c.Username+" "+c.Method+" "+c.Path)
	}
	// Wiederholte gesperrte Lesezugriffe auf denselben Pfad füllen das Audit-Log nicht, Schreibversuche immer
	for i := 0; i < 5; i++ {
		do("GET", "/api/v1/auth/users", tok)
		do("POST", "/api/v1/instances", tok)
	}
	logged = nil
	for _, c := range aud.logged {
		logged = append(logged, c.Username+" "+c.Method+" "+c.Path)
	}
	posts, gets := 0, 0
	for _, l := range logged {
		if strings.Contains(l, "POST /api/v1/instances") {
			posts++
		}
		if strings.Contains(l, "GET /api/v1/auth/users") {
			gets++
		}
	}
	if posts != 6 || gets != 1 {
		t.Errorf("Audit: %d Schreibversuche (erwartet 6), %d gesperrte Lesezugriffe (erwartet 1): %v", posts, gets, logged)
	}
	logged = logged[:3]
	want := []string{"support:ok POST /api/v1/instances", "support:ok GET /api/v1/auth/users", "support:ok GET /api/v1/admin/support-bundle"}
	if len(logged) != 3 || logged[0] != want[0] || logged[1] != want[1] || logged[2] != want[2] {
		t.Errorf("Audit-Log: %v", logged)
	}
}

func TestSupportPrincipalPassesVerbChecksButUserTokenDoesNot(t *testing.T) {
	// Kein einziges Recht vergeben: ein Nutzer bekäme 403, ein Support-Zugang kommt auf freigegebenen Pfaden durch.
	g := &authGate{auth: fakeAuthSvc{userCount: 1, principal: auth.Principal{Username: "bob", UserID: "1"}}, authz: fakeAuthzSvc{allowed: false}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}, support: newFakeSupport()}
	h := g.requireVerbGlobal(authz.VerbAdmin, func(w http.ResponseWriter, r *http.Request) {
		p, ok := principalFromContext(r)
		if !ok || !p.Support || p.Username != "support:ok" {
			t.Errorf("Principal: %+v %v", p, ok)
		}
		w.WriteHeader(200)
	})
	code := func(token string) int {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}
	if c := code(supportaccess.TokenPrefix + "ok.secret"); c != 200 {
		t.Errorf("Support: %d", c)
	}
	if c := code("irgendein.jwt"); c != http.StatusForbidden {
		t.Errorf("Nutzer ohne Recht: %d", c)
	}
	for _, name := range []string{"old", "revoked", "unbekannt"} {
		if c := code(supportaccess.TokenPrefix + name + ".secret"); c != http.StatusUnauthorized {
			t.Errorf("%s: %d", name, c)
		}
	}
	// ohne Support-Speicher ist das Token wertlos
	g.support = nil
	if c := code(supportaccess.TokenPrefix + "ok.secret"); c != http.StatusUnauthorized && c != http.StatusForbidden {
		t.Errorf("ohne Speicher: %d", c)
	}
}

func TestSupportLoginSetsCookieUntilExpiryAndLocksOut(t *testing.T) {
	store := newFakeSupport()
	aud := &recDomainAudit{}
	lim := &fakeLimiter{}
	h := handleSupportLogin(store, aud, lim)
	post := func(token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("POST", "/api/v1/auth/support-login", strings.NewReader(`{"token":"`+token+`"}`)))
		return rec
	}
	rec := post(supportaccess.TokenPrefix + "ok.secret")
	if rec.Code != 200 || store.logins != 1 || len(aud.calls) != 1 || aud.calls[0] != "support:ok|support_access|ok|login" {
		t.Fatalf("%d logins=%d audit=%v", rec.Code, store.logins, aud.calls)
	}
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge <= 0 || cookie.MaxAge > 3600 {
		t.Fatalf("Cookie: %+v", cookie)
	}
	if !strings.Contains(rec.Body.String(), `"note":"Ticket 1"`) {
		t.Errorf("Antwort: %s", rec.Body.String())
	}
	for _, name := range []string{"old", "revoked", "falsch"} {
		if rec := post(supportaccess.TokenPrefix + name + ".secret"); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	// nach drei Fehlversuchen gesperrt, auch mit richtigem Token
	if rec := post(supportaccess.TokenPrefix + "ok.secret"); rec.Code != http.StatusTooManyRequests {
		t.Errorf("Sperre: %d", rec.Code)
	}
}

func TestSupportAccessAdminCreateListRevoke(t *testing.T) {
	store := newFakeSupport()
	aud := &recDomainAudit{}
	req := withPrincipal(httptest.NewRequest("POST", "/x", strings.NewReader(`{"minutes":60,"note":"Ticket 9"}`)), "anna")
	rec := httptest.NewRecorder()
	handleCreateSupportAccess(store, aud)(rec, req)
	var created struct{ ID, Token string }
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &created) != nil || !strings.HasPrefix(created.Token, supportaccess.TokenPrefix) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if len(aud.calls) != 1 || aud.calls[0] != "anna|support_access|neu|created" {
		t.Errorf("Audit: %v", aud.calls)
	}
	// Dauer außerhalb 5 Minuten … 7 Tage
	for _, body := range []string{`{"minutes":1}`, `{"minutes":99999}`} {
		rec := httptest.NewRecorder()
		handleCreateSupportAccess(store, aud)(rec, withPrincipal(httptest.NewRequest("POST", "/x", strings.NewReader(body)), "anna"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", body, rec.Code)
		}
	}
	// Die Liste enthält nie ein Token
	rec = httptest.NewRecorder()
	handleListSupportAccess(store)(rec, httptest.NewRequest("GET", "/x", nil))
	if strings.Contains(rec.Body.String(), "geheim") || strings.Contains(rec.Body.String(), supportaccess.TokenPrefix) || !strings.Contains(rec.Body.String(), `"status":"active"`) {
		t.Errorf("Liste: %s", rec.Body.String())
	}
	// Widerruf
	del := httptest.NewRequest("DELETE", "/x", nil)
	del.SetPathValue("id", "neu")
	rec = httptest.NewRecorder()
	handleRevokeSupportAccess(store, aud)(rec, del)
	if rec.Code != http.StatusNoContent || aud.calls[len(aud.calls)-1] != "|support_access|neu|revoked" {
		t.Errorf("Widerruf: %d %v", rec.Code, aud.calls)
	}
	if _, err := store.Verify(context.Background(), created.Token); !errors.Is(err, supportaccess.ErrRevoked) {
		t.Errorf("nach Widerruf: %v", err)
	}
	gone := httptest.NewRequest("DELETE", "/x", nil)
	gone.SetPathValue("id", "gibtsnicht")
	rec = httptest.NewRecorder()
	handleRevokeSupportAccess(store, aud)(rec, gone)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unbekannt: %d", rec.Code)
	}
}

func TestWhoamiReportsSupportAccess(t *testing.T) {
	store := newFakeSupport()
	req := httptest.NewRequest("GET", "/api/v1/auth/whoami", nil)
	req.Header.Set("Authorization", "Bearer "+supportaccess.TokenPrefix+"ok.secret")
	rec := httptest.NewRecorder()
	handleWhoami(fakeAuthSvc{userCount: 1}, fakeAuthzSvc{}, store)(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["support"] != true || out["authenticated"] != true || out["username"] != "support:ok" || out["canConfigure"] != false || out["supportNote"] != "Ticket 1" {
		t.Fatalf("%v", out)
	}
	req.Header.Set("Authorization", "Bearer "+supportaccess.TokenPrefix+"old.secret")
	rec = httptest.NewRecorder()
	handleWhoami(fakeAuthSvc{userCount: 1}, fakeAuthzSvc{}, store)(rec, req)
	out = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["authenticated"] != false {
		t.Fatalf("abgelaufen: %v", out)
	}
}

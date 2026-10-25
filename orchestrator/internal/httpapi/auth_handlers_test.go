package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// fakeLoginLockout ist ein Test-Doppelgänger für LoginRateLimiter
// (Sicherheits-Härtung 2026-08-10, ARCHITECTURE.md §20.4).
type fakeLoginLockout struct {
	locked          bool
	recordedFailure string
	recordedSuccess string
}

func (f *fakeLoginLockout) Locked(username string) bool { return f.locked }
func (f *fakeLoginLockout) RecordFailure(username string) {
	f.recordedFailure = username
}
func (f *fakeLoginLockout) RecordSuccess(username string) {
	f.recordedSuccess = username
}

// withPrincipal setzt den Principal so in den Request-Kontext, wie es
// requireVerbGlobal/requireAuth im Erfolgsfall tun (auth_middleware.go) —
// hier direkt gesetzt, weil diese Tests die Handler ohne die Middleware
// darüber aufrufen (Kapitel 11 Teil 1, docs/END-GOAL-FEATURES.md §11.4).
func withPrincipal(r *http.Request, username string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), principalContextKey{}, auth.Principal{Username: username}))
}

// --- Sicherheits-Härtung 2026-08-10 (ARCHITECTURE.md §20.4): handleLogin ---

func TestHandleLoginSucceedsRecordsSuccessAndAudits200(t *testing.T) {
	authSvc := fakeAuthSvc{loginToken: "tok", loginExpires: time.Unix(100, 0)}
	audit := &fakeAuditSvc{}
	lockout := &fakeLoginLockout{}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"alice","password":"secret123"}`))
	rec := httptest.NewRecorder()
	handleLogin(authSvc, audit, lockout)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if lockout.recordedSuccess != "alice|192.0.2.1" {
		t.Errorf("RecordSuccess called with %q, want alice", lockout.recordedSuccess)
	}
	if len(audit.logged) != 1 || audit.logged[0].Status != http.StatusOK || audit.logged[0].Username != "alice" {
		t.Errorf("audit.logged = %+v, want one 200 entry for alice", audit.logged)
	}
}

func TestHandleLoginFailureRecordsFailureAndAudits401(t *testing.T) {
	authSvc := fakeAuthSvc{loginErr: auth.ErrInvalidCredentials}
	audit := &fakeAuditSvc{}
	lockout := &fakeLoginLockout{}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"alice","password":"wrong"}`))
	rec := httptest.NewRecorder()
	handleLogin(authSvc, audit, lockout)(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if lockout.recordedFailure != "alice|192.0.2.1" {
		t.Errorf("RecordFailure called with %q, want alice", lockout.recordedFailure)
	}
	if len(audit.logged) != 1 || audit.logged[0].Status != http.StatusUnauthorized {
		t.Errorf("audit.logged = %+v, want one 401 entry", audit.logged)
	}
}

func TestHandleLoginLockedOutSkipsCredentialCheckAndAudits429(t *testing.T) {
	authSvc := fakeAuthSvc{loginToken: "tok"} // würde bei einem Aufruf "erfolgreich" liefern
	audit := &fakeAuditSvc{}
	lockout := &fakeLoginLockout{locked: true}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"alice","password":"secret123"}`))
	rec := httptest.NewRecorder()
	handleLogin(authSvc, audit, lockout)(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (locked out)", rec.Code)
	}
	if lockout.recordedFailure != "" || lockout.recordedSuccess != "" {
		t.Errorf("lockout = %+v, want neither Record* called while already locked", lockout)
	}
	if len(audit.logged) != 1 || audit.logged[0].Status != http.StatusTooManyRequests {
		t.Errorf("audit.logged = %+v, want one 429 entry", audit.logged)
	}
}

func TestHandleListUsersMarksGlobalAdmins(t *testing.T) {
	authSvc := fakeAuthSvc{listedUsers: []auth.User{
		{ID: "u1", Username: "alice", CreatedAt: time.Unix(0, 0)},
		{ID: "u2", Username: "bob", CreatedAt: time.Unix(0, 0)},
	}}
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
		{ID: "b2", Subject: "bob", NodeID: "inst-mixer", Verb: authz.VerbOperate},
	}}

	rec := httptest.NewRecorder()
	handleListUsers(authSvc, authzStore, nil)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/users", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out []userResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	if !out[0].IsAdmin || out[0].Username != "alice" {
		t.Errorf("out[0] = %+v, want alice/isAdmin=true", out[0])
	}
	if out[1].IsAdmin || out[1].Username != "bob" {
		t.Errorf("out[1] = %+v, want bob/isAdmin=false", out[1])
	}
}

func TestHandleDeleteUserBlocksLastAdminDeletingSelf(t *testing.T) {
	authSvc := fakeAuthSvc{}
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/alice", nil)
	req.SetPathValue("name", "alice")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (last admin self-delete)", rec.Code)
	}
}

func TestHandleDeleteUserAllowsSelfDeleteWhenNotLastAdmin(t *testing.T) {
	authSvc := fakeAuthSvc{}
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
		{ID: "b2", Subject: "carol", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/alice", nil)
	req.SetPathValue("name", "alice")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (another admin remains)", rec.Code)
	}
}

func TestHandleDeleteUserAllowsAdminDeletingOtherUser(t *testing.T) {
	authSvc := fakeAuthSvc{}
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/bob", nil)
	req.SetPathValue("name", "bob")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (deleting someone else is fine)", rec.Code)
	}
}

func TestHandleDeleteUserNotFound(t *testing.T) {
	authSvc := fakeAuthSvc{deleteErr: auth.ErrUserNotFound}
	authzStore := fakeAuthzSvc{}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/ghost", nil)
	req.SetPathValue("name", "ghost")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestHandleDeleteUserCleansUpRoleBindings verifiziert den Nutzerfund
// 2026-09-24: role_bindings.subject ist polymorph (kein FK-Cascade wie bei
// group_members möglich), also muss handleDeleteUser explizit aufräumen —
// gleiche Karteileichen-Klasse wie der bereits gefixte Instanz-Bindungs-Leak
// (commit 3f20e65).
func TestHandleDeleteUserCleansUpRoleBindings(t *testing.T) {
	authSvc := fakeAuthSvc{}
	authzStore := recordingDeleteBySubject{fakeAuthzSvc{}, new(string)}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/bob", nil)
	req.SetPathValue("name", "bob")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if *authzStore.got != "bob" {
		t.Errorf("DeleteBySubject called with %q, want %q", *authzStore.got, "bob")
	}
}

// TestHandleDeleteUserNotFoundSkipsBindingCleanup: wenn DeleteUser mit
// "not found" fehlschlägt, darf DeleteBySubject nicht aufgerufen werden —
// es gibt nichts aufzuräumen, und ein leerer/falscher Nutzername sollte nie
// gegen role_bindings laufen.
func TestHandleDeleteUserNotFoundSkipsBindingCleanup(t *testing.T) {
	authSvc := fakeAuthSvc{deleteErr: auth.ErrUserNotFound}
	authzStore := recordingDeleteBySubject{fakeAuthzSvc{}, new(string)}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/users/ghost", nil)
	req.SetPathValue("name", "ghost")
	rec := httptest.NewRecorder()
	handleDeleteUser(authSvc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if *authzStore.got != "" {
		t.Errorf("DeleteBySubject called with %q, want not called at all", *authzStore.got)
	}
}

// recordingDeleteBySubject wraps fakeAuthzSvc to capture the username
// passed to DeleteBySubject.
type recordingDeleteBySubject struct {
	fakeAuthzSvc
	got *string
}

func (r recordingDeleteBySubject) DeleteBySubject(username string) error {
	*r.got = username
	return r.fakeAuthzSvc.deleteBySubjectErr
}

func TestHandleDeleteRoleBindingBlocksLastAdminRemovingOwnBinding(t *testing.T) {
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/role-bindings/b1", nil)
	req.SetPathValue("id", "b1")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteRoleBinding(authzStore, nil)(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (last admin removing own binding)", rec.Code)
	}
}

func TestHandleDeleteRoleBindingAllowsRemovingOtherSubjectsBinding(t *testing.T) {
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
		{ID: "b2", Subject: "bob", NodeID: "inst-mixer", Verb: authz.VerbOperate},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/role-bindings/b2", nil)
	req.SetPathValue("id", "b2")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteRoleBinding(authzStore, nil)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (removing someone else's binding is fine)", rec.Code)
	}
}

func TestHandleResetPasswordRequiresPassword(t *testing.T) {
	authSvc := fakeAuthSvc{}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/alice/password", strings.NewReader(`{}`))
	req.SetPathValue("name", "alice")
	rec := httptest.NewRecorder()
	handleResetPassword(authSvc)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (empty password)", rec.Code)
	}
}

func TestHandleResetPasswordSucceeds(t *testing.T) {
	authSvc := fakeAuthSvc{}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/alice/password", strings.NewReader(`{"password":"neu12345"}`))
	req.SetPathValue("name", "alice")
	rec := httptest.NewRecorder()
	handleResetPassword(authSvc)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

func TestHandleUpdateUserOrgSucceeds(t *testing.T) {
	authSvc := fakeAuthSvc{}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/alice/org", strings.NewReader(`{"orgId":"org-2"}`))
	req.SetPathValue("name", "alice")
	rec := httptest.NewRecorder()
	handleUpdateUserOrg(authSvc)(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

func TestHandleUpdateUserOrgUnknownUserReturnsNotFound(t *testing.T) {
	authSvc := fakeAuthSvc{updateOrgErr: auth.ErrUserNotFound}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/ghost/org", strings.NewReader(`{"orgId":"org-2"}`))
	req.SetPathValue("name", "ghost")
	rec := httptest.NewRecorder()
	handleUpdateUserOrg(authSvc)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleUpdateUserOrgInvalidBodyReturnsBadRequest(t *testing.T) {
	authSvc := fakeAuthSvc{}

	req := httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/alice/org", strings.NewReader(`not-json`))
	req.SetPathValue("name", "alice")
	rec := httptest.NewRecorder()
	handleUpdateUserOrg(authSvc)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleWhoamiBootstrapReportsIsAdminTrue(t *testing.T) {
	authSvc := fakeAuthSvc{userCount: 0}
	authzStore := fakeAuthzSvc{}

	rec := httptest.NewRecorder()
	handleWhoami(authSvc, authzStore)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/whoami", nil))

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["authRequired"] != false || body["isAdmin"] != true {
		t.Errorf("body = %+v, want authRequired=false isAdmin=true (bootstrap)", body)
	}
}

func TestHandleWhoamiReportsIsAdminFromBinding(t *testing.T) {
	authSvc := fakeAuthSvc{userCount: 1, principal: auth.Principal{Username: "alice"}}
	authzStore := fakeAuthzSvc{allowed: true}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/whoami", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handleWhoami(authSvc, authzStore)(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["authenticated"] != true || body["isAdmin"] != true || body["username"] != "alice" {
		t.Errorf("body = %+v, want authenticated=true isAdmin=true username=alice", body)
	}
}

func TestHandleWhoamiReportsIsAdminFalseWithoutBinding(t *testing.T) {
	authSvc := fakeAuthSvc{userCount: 1, principal: auth.Principal{Username: "operator1"}}
	authzStore := fakeAuthzSvc{allowed: false}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/whoami", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handleWhoami(authSvc, authzStore)(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["isAdmin"] != false {
		t.Errorf("body = %+v, want isAdmin=false", body)
	}
}

// --- S5: handleListAuditLog Cursor-Pagination (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) ---

func TestHandleListAuditLogDefaultsWithoutQueryParams(t *testing.T) {
	reader := &fakeAuditSvc{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log", nil)
	rec := httptest.NewRecorder()
	handleListAuditLog(reader)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if reader.lastBefore != 0 || reader.lastLimit != defaultAuditLogLimit {
		t.Errorf("List() called with before=%d limit=%d, want before=0 limit=%d", reader.lastBefore, reader.lastLimit, defaultAuditLogLimit)
	}
}

func TestHandleListAuditLogParsesBeforeAndLimit(t *testing.T) {
	reader := &fakeAuditSvc{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log?before=42&limit=10", nil)
	rec := httptest.NewRecorder()
	handleListAuditLog(reader)(rec, req)

	if reader.lastBefore != 42 || reader.lastLimit != 10 {
		t.Errorf("List() called with before=%d limit=%d, want before=42 limit=10", reader.lastBefore, reader.lastLimit)
	}
}

func TestHandleListAuditLogCapsLimitAtMax(t *testing.T) {
	reader := &fakeAuditSvc{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log?limit=999999", nil)
	rec := httptest.NewRecorder()
	handleListAuditLog(reader)(rec, req)

	if reader.lastLimit != maxAuditLogLimit {
		t.Errorf("List() called with limit=%d, want capped at %d", reader.lastLimit, maxAuditLogLimit)
	}
}

func TestHandleListAuditLogIgnoresInvalidBeforeAndLimit(t *testing.T) {
	reader := &fakeAuditSvc{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log?before=not-a-number&limit=not-a-number", nil)
	rec := httptest.NewRecorder()
	handleListAuditLog(reader)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (invalid params fall back to defaults, no 400)", rec.Code)
	}
	if reader.lastBefore != 0 || reader.lastLimit != defaultAuditLogLimit {
		t.Errorf("List() called with before=%d limit=%d, want defaults before=0 limit=%d", reader.lastBefore, reader.lastLimit, defaultAuditLogLimit)
	}
}

func TestHandleListAuditLogIgnoresNegativeBeforeAndLimit(t *testing.T) {
	reader := &fakeAuditSvc{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/audit-log?before=-5&limit=-5", nil)
	rec := httptest.NewRecorder()
	handleListAuditLog(reader)(rec, req)

	if reader.lastBefore != 0 || reader.lastLimit != defaultAuditLogLimit {
		t.Errorf("List() called with before=%d limit=%d, want defaults before=0 limit=%d", reader.lastBefore, reader.lastLimit, defaultAuditLogLimit)
	}
}

// Audit 2026-10-23 M3: Ein Fremder, der den Namen kennt, darf den echten Nutzer nicht von dessen Adresse aus sperren.
func TestLoginLockoutDoesNotLockOutUserFromOtherAddress(t *testing.T) {
	authSvc := fakeAuthSvc{loginErr: auth.ErrInvalidCredentials}
	audit := &fakeAuditSvc{}
	limits := loginLimits{ip: auth.NewLoginLockoutN(30), name: auth.NewLoginLockoutN(50)}
	lock := auth.NewLoginLockout()
	attempt := func(addr, user string, svc fakeAuthSvc) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"`+user+`","password":"x"}`))
		req.RemoteAddr = addr + ":4000"
		rec := httptest.NewRecorder()
		handleLogin(svc, audit, lock, limits)(rec, req)
		return rec.Code
	}
	for i := 0; i < 6; i++ {
		attempt("203.0.113.9", "alice", authSvc) // Angreifer
	}
	if c := attempt("203.0.113.9", "alice", authSvc); c != http.StatusTooManyRequests {
		t.Fatalf("Angreifer-Adresse ist für alice gesperrt, bekam %d", c)
	}
	ok := fakeAuthSvc{loginToken: "tok", loginExpires: time.Unix(100, 0)}
	if c := attempt("198.51.100.4", "alice", ok); c != http.StatusOK {
		t.Fatalf("alice von ihrer eigenen Adresse darf sich anmelden, bekam %d", c)
	}
}

func TestLoginLockoutPerAddressAcrossNames(t *testing.T) {
	authSvc := fakeAuthSvc{loginErr: auth.ErrInvalidCredentials}
	limits := loginLimits{ip: auth.NewLoginLockoutN(30), name: auth.NewLoginLockoutN(50)}
	lock := auth.NewLoginLockout()
	last := 0
	for i := 0; i < 32; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"user`+strings.Repeat("x", i)+`","password":"x"}`))
		req.RemoteAddr = "203.0.113.9:1"
		rec := httptest.NewRecorder()
		handleLogin(authSvc, &fakeAuditSvc{}, lock, limits)(rec, req)
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("viele Namen von einer Adresse müssen gesperrt werden, letzter Status %d", last)
	}
}

func TestClientIPUsesProxyHeaderOnlyBehindLocalProxy(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "evil, 198.51.100.7")
	if ip := clientIP(r); ip != "198.51.100.7" {
		t.Errorf("letzter Eintrag vom lokalen Proxy: %q", ip)
	}
	r.RemoteAddr = "203.0.113.9:5000"
	if ip := clientIP(r); ip != "203.0.113.9" {
		t.Errorf("direkte Verbindung: Header wird ignoriert: %q", ip)
	}
}

func TestWeakPasswordIsBadRequestOnCreateAndReset(t *testing.T) {
	weak := fmt.Errorf("%w: at least 10 characters required", auth.ErrWeakPassword)
	rec := httptest.NewRecorder()
	handleCreateUser(fakeAuthSvc{userCount: 1, createErr: weak}, fakeAuthzSvc{})(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/users", strings.NewReader(`{"username":"bob","password":"kurz"}`)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "at least 10") {
		t.Fatalf("create: %d %q", rec.Code, rec.Body.String())
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/v1/auth/users/{name}/password", handleResetPassword(fakeAuthSvc{setPasswordErr: weak}))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/auth/users/bob/password", strings.NewReader(`{"password":"kurz"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("reset: %d %q", rec.Code, rec.Body.String())
	}
}

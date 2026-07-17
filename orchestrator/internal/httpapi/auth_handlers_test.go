package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// withPrincipal setzt den Principal so in den Request-Kontext, wie es
// requireVerbGlobal/requireAuth im Erfolgsfall tun (auth_middleware.go) —
// hier direkt gesetzt, weil diese Tests die Handler ohne die Middleware
// darüber aufrufen (Kapitel 11 Teil 1, docs/END-GOAL-FEATURES.md §11.4).
func withPrincipal(r *http.Request, username string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), principalContextKey{}, auth.Principal{Username: username}))
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
	handleListUsers(authSvc, authzStore)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/users", nil))

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
	handleDeleteUser(authSvc, authzStore)(rec, req)

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
	handleDeleteUser(authSvc, authzStore)(rec, req)

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
	handleDeleteUser(authSvc, authzStore)(rec, req)

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
	handleDeleteUser(authSvc, authzStore)(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleDeleteRoleBindingBlocksLastAdminRemovingOwnBinding(t *testing.T) {
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "alice", NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/role-bindings/b1", nil)
	req.SetPathValue("id", "b1")
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteRoleBinding(authzStore)(rec, req)

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
	handleDeleteRoleBinding(authzStore)(rec, req)

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

package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func okHandler(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }

func TestRequireAuthBypassesWhenNoUsersExist(t *testing.T) {
	g := &authGate{auth: fakeAuthSvc{userCount: 0}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}

	rec := httptest.NewRecorder()
	g.requireAuth(okHandler)(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (bootstrap bypass)", rec.Code)
	}
}

func TestRequireAuthRejectsMissingToken(t *testing.T) {
	g := &authGate{auth: fakeAuthSvc{userCount: 1}, authz: fakeAuthzSvc{}, audit: &fakeAuditSvc{}, nodes: fakeNodeLister{}}

	rec := httptest.NewRecorder()
	g.requireAuth(okHandler)(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthRejectsInvalidToken(t *testing.T) {
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, authenticateErr: auth.ErrTokenInvalid},
		authz: fakeAuthzSvc{},
		audit: &fakeAuditSvc{},
		nodes: fakeNodeLister{},
	}

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer bogus")
	rec := httptest.NewRecorder()
	g.requireAuth(okHandler)(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthAcceptsValidTokenAndSetsPrincipal(t *testing.T) {
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "alice"}},
		authz: fakeAuthzSvc{},
		audit: &fakeAuditSvc{},
		nodes: fakeNodeLister{},
	}

	var gotUsername string
	next := func(w http.ResponseWriter, r *http.Request) {
		p, _ := principalFromContext(r)
		gotUsername = p.Username
		w.WriteHeader(http.StatusOK)
	}

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireAuth(next)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotUsername != "alice" {
		t.Errorf("principal username = %q, want alice", gotUsername)
	}
}

func TestRequireAuthAcceptsQueryParamTokenForSSE(t *testing.T) {
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "alice"}},
		authz: fakeAuthzSvc{},
		audit: &fakeAuditSvc{},
		nodes: fakeNodeLister{},
	}

	rec := httptest.NewRecorder()
	g.requireAuth(okHandler)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/events?access_token=valid-token", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (query-param token for EventSource)", rec.Code)
	}
}

func TestRequireVerbOnNodeForbidsInsufficientVerbAndAudits(t *testing.T) {
	auditLog := &fakeAuditSvc{}
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz: fakeAuthzSvc{allowed: false},
		audit: auditLog,
		nodes: fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if len(auditLog.logged) != 1 || auditLog.logged[0].Status != http.StatusForbidden || auditLog.logged[0].NodeID != "inst-mixer" {
		t.Fatalf("audit log = %+v, want one 403 entry for inst-mixer", auditLog.logged)
	}
}

func TestRequireVerbOnNodeAllowsSufficientVerbAndAuditsWrites(t *testing.T) {
	auditLog := &fakeAuditSvc{}
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz: fakeAuthzSvc{allowed: true},
		audit: auditLog,
		nodes: fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(auditLog.logged) != 1 || auditLog.logged[0].Status != http.StatusOK || auditLog.logged[0].NodeID != "inst-mixer" {
		t.Fatalf("audit log = %+v, want one 200 entry for inst-mixer", auditLog.logged)
	}
}

func TestRequireVerbOnNodeDoesNotAuditReads(t *testing.T) {
	auditLog := &fakeAuditSvc{}
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz: fakeAuthzSvc{allowed: true},
		audit: auditLog,
		nodes: fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbView, okHandler)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(auditLog.logged) != 0 {
		t.Fatalf("audit log = %+v, want no entries for a read", auditLog.logged)
	}
}

func TestRequireVerbGlobalChecksWildcardScope(t *testing.T) {
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "engineer1"}},
		authz: fakeAuthzSvc{allowed: true},
		audit: &fakeAuditSvc{},
		nodes: fakeNodeLister{},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/graph/edges", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbGlobal(authz.VerbConfigure, okHandler)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestRequireVerbOnNodeFallsBackToRawIDForUnknownNode(t *testing.T) {
	auditLog := &fakeAuditSvc{}
	var checkedNodeID string
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz: recordingAuthz{fakeAuthzSvc{allowed: true}, &checkedNodeID},
		audit: auditLog,
		nodes: fakeNodeLister{},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/does-not-exist/params/gain", nil)
	req.SetPathValue("id", "does-not-exist")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if checkedNodeID != "does-not-exist" {
		t.Errorf("checked nodeID = %q, want raw path id as fallback", checkedNodeID)
	}
}

// recordingAuthz wraps fakeAuthzSvc to capture the nodeID passed to Check.
type recordingAuthz struct {
	fakeAuthzSvc
	got *string
}

func (r recordingAuthz) Check(subject, nodeID string, minVerb authz.Verb) (bool, error) {
	*r.got = nodeID
	return r.fakeAuthzSvc.allowed, nil
}

// --- Kapitel 12 Teil 4: Workflow-Scope-AuthZ ---

// fakeWorkflowRoleFinder ist ein Test-Double für WorkflowRoleFinder.
type fakeWorkflowRoleFinder struct {
	workflowID, workflowName, role string
	found                          bool
	calls                          int
}

func (f *fakeWorkflowRoleFinder) FindRoleForNode(nodeID string) (string, string, string, bool) {
	f.calls++
	return f.workflowID, f.workflowName, f.role, f.found
}

func TestRequireVerbOnNodeAllowsViaWorkflowScopeWhenGlobalCheckFails(t *testing.T) {
	auditLog := &fakeAuditSvc{}
	g := &authGate{
		auth:      fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "bildmeister"}},
		authz:     fakeAuthzSvc{allowed: false, workflowAllowed: true},
		audit:     auditLog,
		nodes:     fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
		workflows: &fakeWorkflowRoleFinder{workflowID: "wf-1", role: "mixer", found: true},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (workflow-scoped binding must grant access even though the global check failed)", rec.Code)
	}
}

func TestRequireVerbOnNodeForbidsWhenNeitherScopeMatches(t *testing.T) {
	g := &authGate{
		auth:      fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "bildmeister"}},
		authz:     fakeAuthzSvc{allowed: false, workflowAllowed: false},
		audit:     &fakeAuditSvc{},
		nodes:     fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
		workflows: &fakeWorkflowRoleFinder{workflowID: "wf-1", role: "mixer", found: true},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (neither global nor workflow-scoped binding matches)", rec.Code)
	}
}

func TestRequireVerbOnNodeSkipsWorkflowCheckWhenNodeBelongsToNoWorkflow(t *testing.T) {
	finder := &fakeWorkflowRoleFinder{found: false}
	g := &authGate{
		auth:      fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz:     fakeAuthzSvc{allowed: false, workflowAllowed: true}, // würde fälschlich erlauben, falls doch aufgerufen
		audit:     &fakeAuditSvc{},
		nodes:     fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
		workflows: finder,
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (node belongs to no workflow, must not fall back to CheckWorkflow's stray true)", rec.Code)
	}
	if finder.calls != 1 {
		t.Fatalf("FindRoleForNode calls = %d, want exactly 1", finder.calls)
	}
}

func TestRequireVerbOnNodeNilWorkflowsFieldSkipsWorkflowCheck(t *testing.T) {
	// g.workflows bleibt nil (Zero-Value) — muss nicht panicen und darf
	// nur die globale Prüfung anwenden (Rückwärtskompatibilität für
	// Aufrufer, die authGate ohne WorkflowRoleFinder konstruieren).
	g := &authGate{
		auth:  fakeAuthSvc{userCount: 1, principal: auth.Principal{UserID: "u1", Username: "operator1"}},
		authz: fakeAuthzSvc{allowed: false},
		audit: &fakeAuditSvc{},
		nodes: fakeNodeLister{nodes: []registry.NodeView{{ID: "node-1", InstanceID: "inst-mixer"}}},
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/nodes/node-1/params/gain", nil)
	req.SetPathValue("id", "node-1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	g.requireVerbOnNode(authz.VerbOperate, okHandler)(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (nil workflows field must not panic, no workflow-scope match possible)", rec.Code)
	}
}

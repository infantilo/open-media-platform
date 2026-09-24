package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/groups"
)

// fakeGroupSvc implementiert GroupService minimal für Handler-Tests —
// nur die für die jeweiligen Tests relevanten Felder sind belegt,
// gleiches Muster wie fakeAuthzSvc/fakeAuthSvc in server_test.go.
type fakeGroupSvc struct {
	members       map[string][]string
	countBindings int
	deleteErr     error
	deletedID     string
	deletedCasc   bool
}

func (f *fakeGroupSvc) Create(name, description, createdBy string) (groups.Group, error) {
	return groups.Group{}, nil
}
func (f *fakeGroupSvc) Get(id string) (groups.Group, error) { return groups.Group{}, nil }
func (f *fakeGroupSvc) List() ([]groups.Group, error)       { return nil, nil }
func (f *fakeGroupSvc) UpdateMeta(id, name, desc string) (groups.Group, error) {
	return groups.Group{}, nil
}
func (f *fakeGroupSvc) CountBindings(id string) (int, error) { return f.countBindings, nil }
func (f *fakeGroupSvc) Delete(id string, cascade bool) error {
	f.deletedID, f.deletedCasc = id, cascade
	return f.deleteErr
}
func (f *fakeGroupSvc) ListMembers(groupID string) ([]string, error) { return f.members[groupID], nil }
func (f *fakeGroupSvc) AddMember(groupID, username string) error     { return nil }
func (f *fakeGroupSvc) RemoveMember(groupID, username string) error  { return nil }

// TestHandleDeleteGroupCascadeBlocksLastAdminViaGroupMembership belegt
// den Nachtrag-Fund: ein Admin, dessen EINZIGES globales Admin-Recht
// über eine Gruppe kommt, darf diese Gruppe nicht kaskadierend löschen
// (sonst identischer Aussperr-Effekt wie das direkte Löschen der
// Bindung, ohne von handleDeleteRoleBinding erfasst zu werden).
func TestHandleDeleteGroupCascadeBlocksLastAdminViaGroupMembership(t *testing.T) {
	groupID := "grp-sole-admin"
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: groupID, SubjectType: authz.SubjectTypeGroup, NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}
	svc := &fakeGroupSvc{members: map[string][]string{groupID: {"alice"}}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/groups/"+groupID+"?cascade=true", nil)
	req.SetPathValue("id", groupID)
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteGroup(svc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (cannot delete own last admin path); body=%s", rec.Code, rec.Body.String())
	}
	if svc.deletedID != "" {
		t.Fatalf("Delete() was called (id=%q) despite the block — must not reach the store", svc.deletedID)
	}
}

// TestHandleDeleteGroupCascadeAllowsWhenAnotherAdminExists belegt das
// Gegenstück: existiert ein zweiter globaler Admin, blockiert die
// Prüfung nicht — Alice bleibt aussperrbar-sicher, aber die Aktion
// selbst darf durch.
func TestHandleDeleteGroupCascadeAllowsWhenAnotherAdminExists(t *testing.T) {
	groupID := "grp-sole-admin"
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: groupID, SubjectType: authz.SubjectTypeGroup, NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
		{ID: "b2", Subject: "bob", SubjectType: authz.SubjectTypeUser, NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}
	svc := &fakeGroupSvc{members: map[string][]string{groupID: {"alice"}}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/groups/"+groupID+"?cascade=true", nil)
	req.SetPathValue("id", groupID)
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteGroup(svc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a second admin exists, deletion must proceed); body=%s", rec.Code, rec.Body.String())
	}
	if svc.deletedID != groupID || !svc.deletedCasc {
		t.Fatalf("Delete() called with (%q, %v), want (%q, true)", svc.deletedID, svc.deletedCasc, groupID)
	}
}

// TestHandleDeleteGroupCascadeAllowsNonMemberEvenIfSoleAdmin belegt:
// die Sperre gilt nur, wenn der anfragende Nutzer selbst Mitglied
// dieser konkreten Gruppe ist — ein Admin, dessen Recht über eine
// ANDERE Gruppe kommt, darf diese hier löschen.
func TestHandleDeleteGroupCascadeAllowsNonMemberEvenIfSoleAdmin(t *testing.T) {
	groupID := "grp-unrelated"
	authzStore := fakeAuthzSvc{bindings: []authz.Binding{
		{ID: "b1", Subject: "grp-other", SubjectType: authz.SubjectTypeGroup, NodeID: authz.AnyNode, Verb: authz.VerbAdmin},
	}}
	svc := &fakeGroupSvc{members: map[string][]string{
		"grp-other": {"alice"},
		groupID:     {"bob"},
	}}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/groups/"+groupID+"?cascade=true", nil)
	req.SetPathValue("id", groupID)
	req = withPrincipal(req, "alice")
	rec := httptest.NewRecorder()
	handleDeleteGroup(svc, authzStore, nil)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (alice is not a member of the group being deleted); body=%s", rec.Code, rec.Body.String())
	}
}

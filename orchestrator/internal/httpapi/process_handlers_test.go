package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

// fakeHumanTaskStore implementiert nur den für diese Tests nötigen
// Ausschnitt von ProcessStoreService (GetHumanTask/AssignHumanTask) —
// die restlichen Methoden bräuchte kein Test hier, sind aber Teil des
// Interfaces und müssen daher (leer) vorhanden sein.
type fakeHumanTaskStore struct {
	task         process.HumanTask
	getErr       error
	assignResult process.HumanTask
	assignErr    error
	assignCalled bool
}

func (f *fakeHumanTaskStore) CreateDefinition(name, description, category, createdBy string) (process.ProcessDefinition, error) {
	return process.ProcessDefinition{}, nil
}
func (f *fakeHumanTaskStore) GetDefinition(id string) (process.ProcessDefinition, error) {
	return process.ProcessDefinition{}, nil
}
func (f *fakeHumanTaskStore) ListDefinitions() ([]process.ProcessDefinition, error) { return nil, nil }
func (f *fakeHumanTaskStore) UpdateDefinitionMeta(id, name, description, category string) (process.ProcessDefinition, error) {
	return process.ProcessDefinition{}, nil
}
func (f *fakeHumanTaskStore) CreateVersion(processDefinitionID string, definition process.Definition, createdBy string) (process.ProcessVersion, error) {
	return process.ProcessVersion{}, nil
}
func (f *fakeHumanTaskStore) GetVersion(id string) (process.ProcessVersion, error) {
	return process.ProcessVersion{}, nil
}
func (f *fakeHumanTaskStore) ListVersions(processDefinitionID string) ([]process.ProcessVersion, error) {
	return nil, nil
}
func (f *fakeHumanTaskStore) PublishVersion(id string) (process.ProcessVersion, error) {
	return process.ProcessVersion{}, nil
}
func (f *fakeHumanTaskStore) DeprecateVersion(id string) (process.ProcessVersion, error) {
	return process.ProcessVersion{}, nil
}
func (f *fakeHumanTaskStore) ArchiveVersion(id string) (process.ProcessVersion, error) {
	return process.ProcessVersion{}, nil
}
func (f *fakeHumanTaskStore) GetExecution(id string) (process.ProcessExecution, error) {
	return process.ProcessExecution{}, nil
}
func (f *fakeHumanTaskStore) ListExecutions(filter process.ExecutionFilter) ([]process.ProcessExecution, error) {
	return nil, nil
}
func (f *fakeHumanTaskStore) ListStepExecutions(processExecutionID string) ([]process.ProcessStepExecution, error) {
	return nil, nil
}
func (f *fakeHumanTaskStore) ListHumanTasksByExecution(processExecutionID string) ([]process.HumanTask, error) {
	return nil, nil
}
func (f *fakeHumanTaskStore) ListHumanTasksByAssignee(assignee string) ([]process.HumanTask, error) {
	return nil, nil
}
func (f *fakeHumanTaskStore) GetHumanTask(id string) (process.HumanTask, error) {
	return f.task, f.getErr
}
func (f *fakeHumanTaskStore) AssignHumanTask(id, assignee string) (process.HumanTask, error) {
	f.assignCalled = true
	return f.assignResult, f.assignErr
}

// fakeHumanTaskEngine implementiert nur CompleteHumanTask aus
// ProcessEngineService — s. fakeHumanTaskStore-Kommentar.
type fakeHumanTaskEngine struct {
	result       process.HumanTask
	err          error
	completedID  string
	completeCall bool
}

func (f *fakeHumanTaskEngine) Start(params process.CreateExecutionParams) (process.ProcessExecution, error) {
	return process.ProcessExecution{}, nil
}
func (f *fakeHumanTaskEngine) Cancel(executionID string) (process.ProcessExecution, error) {
	return process.ProcessExecution{}, nil
}
func (f *fakeHumanTaskEngine) Pause(executionID string) (process.ProcessExecution, error) {
	return process.ProcessExecution{}, nil
}
func (f *fakeHumanTaskEngine) Resume(executionID string) (process.ProcessExecution, error) {
	return process.ProcessExecution{}, nil
}
func (f *fakeHumanTaskEngine) CompleteHumanTask(humanTaskID string, expectedRowVersion int, status, decision, comment string) (process.HumanTask, error) {
	f.completeCall = true
	f.completedID = humanTaskID
	return f.result, f.err
}
func (f *fakeHumanTaskEngine) StepTypes() []process.StepType { return nil }

// TestAssignHumanTask_UnassignedTaskAnyOperatorMayClaim — "Für mich
// beanspruchen" muss für einen noch offenen Pool-/Rollen-Task
// funktionieren, s. ui/shell/process-view.ts #claimTask.
func TestAssignHumanTask_UnassignedTaskAnyOperatorMayClaim(t *testing.T) {
	svc := &fakeHumanTaskStore{
		task:         process.HumanTask{ID: "t1", Assignee: ""},
		assignResult: process.HumanTask{ID: "t1", Assignee: "alice"},
	}
	h := handleAssignHumanTask(svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"assignee":"alice"}`)), "alice")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !svc.assignCalled {
		t.Error("AssignHumanTask was not called")
	}
}

// TestAssignHumanTask_AssignedToSomeoneElseIsForbidden — der
// live gefundene Bug aus Nachtrag 272/274: ein bereits jemand anderem
// zugewiesener Task darf nicht von einem beliebigen Operate-Nutzer neu
// zugewiesen ("gestohlen") werden.
func TestAssignHumanTask_AssignedToSomeoneElseIsForbidden(t *testing.T) {
	svc := &fakeHumanTaskStore{task: process.HumanTask{ID: "t1", Assignee: "bob"}}
	h := handleAssignHumanTask(svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"assignee":"eve"}`)), "eve")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s, want 403", rec.Code, rec.Body.String())
	}
	if svc.assignCalled {
		t.Error("AssignHumanTask was called despite caller not being the assignee")
	}
}

// TestAssignHumanTask_CurrentAssigneeMayReassign — der bestehende
// Zuständige darf seinen eigenen Task an jemand anderen weiterreichen
// (Delegation) — selbst genau das Recht, das nicht dem VerbAdmin-
// Ausweg braucht.
func TestAssignHumanTask_CurrentAssigneeMayReassign(t *testing.T) {
	svc := &fakeHumanTaskStore{
		task:         process.HumanTask{ID: "t1", Assignee: "bob"},
		assignResult: process.HumanTask{ID: "t1", Assignee: "carol"},
	}
	h := handleAssignHumanTask(svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"assignee":"carol"}`)), "bob")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !svc.assignCalled {
		t.Error("AssignHumanTask was not called")
	}
}

// TestAssignHumanTask_AdminMayReassignAnyTask — Eskalations-/
// Vertretungsweg.
func TestAssignHumanTask_AdminMayReassignAnyTask(t *testing.T) {
	svc := &fakeHumanTaskStore{
		task:         process.HumanTask{ID: "t1", Assignee: "bob"},
		assignResult: process.HumanTask{ID: "t1", Assignee: "carol"},
	}
	h := handleAssignHumanTask(svc, fakeAuthzSvc{allowed: true}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"assignee":"carol"}`)), "admin")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !svc.assignCalled {
		t.Error("AssignHumanTask was not called")
	}
}

// TestCompleteHumanTask_NonAssigneeIsForbidden — der eigentliche live
// gefundene Bug (Nachtrag 272/274): jeder Operate-Nutzer konnte bislang
// eine fremde, bereits zugewiesene Human-Task entscheiden.
func TestCompleteHumanTask_NonAssigneeIsForbidden(t *testing.T) {
	svc := &fakeHumanTaskStore{task: process.HumanTask{ID: "t1", Assignee: "bob"}}
	engine := &fakeHumanTaskEngine{}
	h := handleCompleteHumanTask(engine, svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"expectedRowVersion":1,"status":"approved"}`)), "eve")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s, want 403", rec.Code, rec.Body.String())
	}
	if engine.completeCall {
		t.Error("CompleteHumanTask was called despite caller not being the assignee")
	}
}

// TestCompleteHumanTask_AssigneeMaySucceed — die legitime
// #claimTask-Folge (assign(self) dann complete("claimed")) muss
// weiterhin funktionieren.
func TestCompleteHumanTask_AssigneeMaySucceed(t *testing.T) {
	svc := &fakeHumanTaskStore{task: process.HumanTask{ID: "t1", Assignee: "bob"}}
	engine := &fakeHumanTaskEngine{result: process.HumanTask{ID: "t1", Assignee: "bob", Status: "claimed"}}
	h := handleCompleteHumanTask(engine, svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"expectedRowVersion":1,"status":"claimed"}`)), "bob")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !engine.completeCall || engine.completedID != "t1" {
		t.Error("CompleteHumanTask was not called with the right id")
	}
}

// TestCompleteHumanTask_AdminMayOverride — Eskalationsweg.
func TestCompleteHumanTask_AdminMayOverride(t *testing.T) {
	svc := &fakeHumanTaskStore{task: process.HumanTask{ID: "t1", Assignee: "bob"}}
	engine := &fakeHumanTaskEngine{result: process.HumanTask{ID: "t1", Status: "cancelled"}}
	h := handleCompleteHumanTask(engine, svc, fakeAuthzSvc{allowed: true}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"expectedRowVersion":1,"status":"cancelled"}`)), "admin")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !engine.completeCall {
		t.Error("CompleteHumanTask was not called")
	}
}

// TestCompleteHumanTask_UnassignedTaskAnyOperatorMayAct — z. B. ein
// noch unzugewiesener Pool-Task wird direkt abgebrochen/eskaliert,
// ohne vorher geclaimt worden zu sein (beide sind laut
// HumanTaskTransitions gültige Übergänge ab "pending").
func TestCompleteHumanTask_UnassignedTaskAnyOperatorMayAct(t *testing.T) {
	svc := &fakeHumanTaskStore{task: process.HumanTask{ID: "t1", Assignee: ""}}
	engine := &fakeHumanTaskEngine{result: process.HumanTask{ID: "t1", Status: "cancelled"}}
	h := handleCompleteHumanTask(engine, svc, fakeAuthzSvc{allowed: false}, nil)

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"expectedRowVersion":1,"status":"cancelled"}`)), "someone")
	req.SetPathValue("id", "t1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	if !engine.completeCall {
		t.Error("CompleteHumanTask was not called")
	}
}

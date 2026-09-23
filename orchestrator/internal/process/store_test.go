package process

import (
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

// testDB liefert eine migrierte, isolierte Testdatenbank — niemals die
// echte Dev-Postgres (dbtest.Open, docs/decisions.md Nachtrag 128).
// process_executions cascadiert nach step_executions/human_tasks,
// process_definitions cascadiert nach process_versions (s.
// 0018_process.sql) — zwei DELETEs reichen für einen sauberen Reset.
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM process_executions`); err != nil {
			t.Fatalf("cleanup process_executions: %v", err)
		}
		if _, err := database.Exec(`DELETE FROM process_definitions`); err != nil {
			t.Fatalf("cleanup process_definitions: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func TestDefinitionCreateGetList(t *testing.T) {
	s := NewStore(testDB(t))

	pd, err := s.CreateDefinition("Ingest Review", "desc", "media", "alice", "")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}
	if pd.ID == "" {
		t.Fatalf("CreateDefinition() = %+v, want non-empty ID", pd)
	}

	got, err := s.GetDefinition(pd.ID)
	if err != nil {
		t.Fatalf("GetDefinition() error = %v", err)
	}
	if got.Name != "Ingest Review" || got.CreatedBy != "alice" {
		t.Errorf("GetDefinition() = %+v, unexpected", got)
	}

	list, err := s.ListDefinitions()
	if err != nil {
		t.Fatalf("ListDefinitions() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListDefinitions() = %d entries, want 1", len(list))
	}
}

func TestDefinitionGetUnknownReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	if _, err := s.GetDefinition("does-not-exist"); err != ErrNotFound {
		t.Fatalf("GetDefinition() error = %v, want ErrNotFound", err)
	}
}

func TestVersionCreateAutoIncrementsAndRejectsInvalidDefinition(t *testing.T) {
	s := NewStore(testDB(t))
	pd, err := s.CreateDefinition("QC Flow", "", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}

	v1, err := s.CreateVersion(pd.ID, validDefinition(), "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	if v1.VersionNumber != 1 || v1.Status != VersionStatusDraft {
		t.Errorf("CreateVersion() = %+v, want versionNumber=1 status=draft", v1)
	}

	v2, err := s.CreateVersion(pd.ID, validDefinition(), "alice")
	if err != nil {
		t.Fatalf("CreateVersion() (2nd) error = %v", err)
	}
	if v2.VersionNumber != 2 {
		t.Errorf("CreateVersion() (2nd) versionNumber = %d, want 2", v2.VersionNumber)
	}

	bad := Definition{StartStepID: "missing"}
	if _, err := s.CreateVersion(pd.ID, bad, "alice"); err == nil {
		t.Fatalf("CreateVersion() with invalid definition error = nil, want error")
	}

	if _, err := s.CreateVersion("does-not-exist", validDefinition(), "alice"); err != ErrNotFound {
		t.Fatalf("CreateVersion() for unknown definition error = %v, want ErrNotFound", err)
	}

	list, err := s.ListVersions(pd.ID)
	if err != nil {
		t.Fatalf("ListVersions() error = %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("ListVersions() = %d entries, want 2", len(list))
	}
	if list[0].VersionNumber != 2 {
		t.Errorf("ListVersions()[0].VersionNumber = %d, want 2 (newest first)", list[0].VersionNumber)
	}

	// Roundtrip: die gespeicherte Definition muss exakt zurückkommen.
	fetched, err := s.GetVersion(v1.ID)
	if err != nil {
		t.Fatalf("GetVersion() error = %v", err)
	}
	if len(fetched.Definition.Steps) != len(validDefinition().Steps) {
		t.Errorf("GetVersion() definition.steps = %d, want %d", len(fetched.Definition.Steps), len(validDefinition().Steps))
	}
}

func TestVersionLifecycleTransitions(t *testing.T) {
	s := NewStore(testDB(t))
	pd, _ := s.CreateDefinition("Approval Flow", "", "", "alice", "")
	v, err := s.CreateVersion(pd.ID, validDefinition(), "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}

	// Invalider Übergang: draft direkt nach deprecated.
	if _, err := s.DeprecateVersion(v.ID); err == nil {
		t.Fatalf("DeprecateVersion() from draft error = nil, want error (must publish first)")
	}

	published, err := s.PublishVersion(v.ID)
	if err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}
	if published.Status != VersionStatusPublished || published.PublishedAt == nil {
		t.Errorf("PublishVersion() = %+v, want status=published and PublishedAt set", published)
	}

	// Erneutes Publish (schon published) muss scheitern — kein Doppel-Publish.
	if _, err := s.PublishVersion(v.ID); err == nil {
		t.Fatalf("PublishVersion() twice error = nil, want error")
	}

	deprecated, err := s.DeprecateVersion(v.ID)
	if err != nil {
		t.Fatalf("DeprecateVersion() error = %v", err)
	}
	if deprecated.Status != VersionStatusDeprecated {
		t.Errorf("DeprecateVersion() status = %s, want deprecated", deprecated.Status)
	}

	archived, err := s.ArchiveVersion(v.ID)
	if err != nil {
		t.Fatalf("ArchiveVersion() error = %v", err)
	}
	if archived.Status != VersionStatusArchived {
		t.Errorf("ArchiveVersion() status = %s, want archived", archived.Status)
	}
}

func createPublishedVersion(t *testing.T, s *Store) (ProcessDefinition, ProcessVersion) {
	t.Helper()
	pd, err := s.CreateDefinition("Exec Flow", "", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}
	v, err := s.CreateVersion(pd.ID, validDefinition(), "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	v, err = s.PublishVersion(v.ID)
	if err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}
	return pd, v
}

func TestExecutionCreateDefaultsCorrelationIDToOwnID(t *testing.T) {
	s := NewStore(testDB(t))
	pd, v := createPublishedVersion(t, s)

	e, err := s.CreateExecution(CreateExecutionParams{
		ProcessDefinitionID: pd.ID,
		ProcessVersionID:    v.ID,
		CreatedBy:           "bob",
	})
	if err != nil {
		t.Fatalf("CreateExecution() error = %v", err)
	}
	if e.Status != StatusPending {
		t.Errorf("CreateExecution() status = %s, want pending", e.Status)
	}
	if e.CorrelationID != e.ID {
		t.Errorf("CreateExecution() correlationId = %s, want own id %s", e.CorrelationID, e.ID)
	}
	if e.RowVersion != 1 {
		t.Errorf("CreateExecution() rowVersion = %d, want 1", e.RowVersion)
	}

	got, err := s.GetExecution(e.ID)
	if err != nil {
		t.Fatalf("GetExecution() error = %v", err)
	}
	if got.CreatedBy != "bob" {
		t.Errorf("GetExecution().CreatedBy = %s, want bob", got.CreatedBy)
	}
}

func TestExecutionStatusTransitionsAndOptimisticConcurrency(t *testing.T) {
	s := NewStore(testDB(t))
	pd, v := createPublishedVersion(t, s)
	e, err := s.CreateExecution(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "bob"})
	if err != nil {
		t.Fatalf("CreateExecution() error = %v", err)
	}

	// Invalider Übergang: pending -> completed ohne running dazwischen.
	if _, err := s.UpdateExecutionStatus(e.ID, e.RowVersion, StatusCompleted, ""); err == nil {
		t.Fatalf("UpdateExecutionStatus(pending->completed) error = nil, want error")
	}

	running, err := s.UpdateExecutionStatus(e.ID, e.RowVersion, StatusRunning, "")
	if err != nil {
		t.Fatalf("UpdateExecutionStatus(pending->running) error = %v", err)
	}
	if running.RowVersion != e.RowVersion+1 {
		t.Errorf("UpdateExecutionStatus() rowVersion = %d, want %d", running.RowVersion, e.RowVersion+1)
	}

	// CAS-Konflikt: veralteter RowVersion wird abgelehnt.
	if _, err := s.UpdateExecutionStatus(e.ID, e.RowVersion, StatusCompleted, ""); err != ErrConcurrentModification {
		t.Fatalf("UpdateExecutionStatus() with stale rowVersion error = %v, want ErrConcurrentModification", err)
	}

	completed, err := s.UpdateExecutionStatus(e.ID, running.RowVersion, StatusCompleted, "")
	if err != nil {
		t.Fatalf("UpdateExecutionStatus(running->completed) error = %v", err)
	}
	if completed.CompletedAt == nil {
		t.Errorf("UpdateExecutionStatus() to terminal state did not set CompletedAt")
	}

	out, err := s.SetExecutionOutput(e.ID, completed.RowVersion, json.RawMessage(`{"result":"ok"}`))
	if err != nil {
		t.Fatalf("SetExecutionOutput() error = %v", err)
	}
	// Semantischer Vergleich statt Byte-Gleichheit: Postgres JSONB
	// normalisiert Whitespace (z. B. ein Leerzeichen nach ":") beim
	// Roundtrip, das ist kein Store-Fehler.
	var gotOutput, wantOutput map[string]any
	if err := json.Unmarshal(out.Output, &gotOutput); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"result":"ok"}`), &wantOutput); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	if gotOutput["result"] != wantOutput["result"] {
		t.Errorf("SetExecutionOutput() output = %s, want result=ok", out.Output)
	}
}

func TestListExecutionsFiltersByStatus(t *testing.T) {
	s := NewStore(testDB(t))
	pd, v := createPublishedVersion(t, s)
	e1, _ := s.CreateExecution(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "bob"})
	_, _ = s.CreateExecution(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "bob"})
	if _, err := s.UpdateExecutionStatus(e1.ID, e1.RowVersion, StatusRunning, ""); err != nil {
		t.Fatalf("UpdateExecutionStatus() error = %v", err)
	}

	running, err := s.ListExecutions(ExecutionFilter{ProcessDefinitionID: pd.ID, Status: StatusRunning})
	if err != nil {
		t.Fatalf("ListExecutions() error = %v", err)
	}
	if len(running) != 1 || running[0].ID != e1.ID {
		t.Fatalf("ListExecutions(status=running) = %+v, want exactly [%s]", running, e1.ID)
	}

	pending, err := s.ListExecutions(ExecutionFilter{ProcessDefinitionID: pd.ID, Status: StatusPending})
	if err != nil {
		t.Fatalf("ListExecutions() error = %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("ListExecutions(status=pending) = %d entries, want 1", len(pending))
	}

	all, err := s.ListExecutions(ExecutionFilter{ProcessDefinitionID: pd.ID})
	if err != nil {
		t.Fatalf("ListExecutions() error = %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("ListExecutions(no status filter) = %d entries, want 2", len(all))
	}
}

func TestStepExecutionLifecycleAndRetry(t *testing.T) {
	s := NewStore(testDB(t))
	pd, v := createPublishedVersion(t, s)
	e, _ := s.CreateExecution(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "bob"})

	step, err := s.CreateStepExecution(e.ID, "transcode", StepTypeMediaFunction, json.RawMessage(`{"src":"a.mov"}`))
	if err != nil {
		t.Fatalf("CreateStepExecution() error = %v", err)
	}
	if step.Attempt != 1 || step.Status != StatusPending {
		t.Errorf("CreateStepExecution() = %+v, want attempt=1 status=pending", step)
	}

	running, err := s.UpdateStepExecutionStatus(step.ID, step.RowVersion, StatusRunning, "")
	if err != nil {
		t.Fatalf("UpdateStepExecutionStatus(pending->running) error = %v", err)
	}
	failed, err := s.UpdateStepExecutionStatus(running.ID, running.RowVersion, StatusFailed, "encoder crashed")
	if err != nil {
		t.Fatalf("UpdateStepExecutionStatus(running->failed) error = %v", err)
	}
	if failed.Error != "encoder crashed" || failed.CompletedAt == nil {
		t.Errorf("UpdateStepExecutionStatus() to failed = %+v, want error set and CompletedAt set", failed)
	}

	retried, err := s.RetryStepExecution(failed.ID, failed.RowVersion)
	if err != nil {
		t.Fatalf("RetryStepExecution() error = %v", err)
	}
	if retried.Attempt != 2 {
		t.Errorf("RetryStepExecution() attempt = %d, want 2", retried.Attempt)
	}
	if retried.Status != StatusPending || retried.CompletedAt != nil {
		t.Errorf("RetryStepExecution() = %+v, want status=pending, CompletedAt=nil", retried)
	}
	if retried.ID != failed.ID {
		t.Errorf("RetryStepExecution() created a new row (id changed) — A4 requires the same row, not a new one per attempt")
	}

	steps, err := s.ListStepExecutions(e.ID)
	if err != nil {
		t.Fatalf("ListStepExecutions() error = %v", err)
	}
	if len(steps) != 1 {
		t.Fatalf("ListStepExecutions() = %d rows, want exactly 1 (retry must not add a row)", len(steps))
	}
}

func TestHumanTaskLifecycle(t *testing.T) {
	s := NewStore(testDB(t))
	pd, v := createPublishedVersion(t, s)
	e, _ := s.CreateExecution(CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "bob"})

	task, err := s.CreateHumanTask(CreateHumanTaskParams{
		ProcessExecutionID: e.ID,
		Title:              "Review transcode",
		Role:               "editor",
	})
	if err != nil {
		t.Fatalf("CreateHumanTask() error = %v", err)
	}
	if task.Status != HumanTaskStatusPending || task.Priority != "normal" {
		t.Errorf("CreateHumanTask() = %+v, want status=pending priority=normal", task)
	}

	assigned, err := s.AssignHumanTask(task.ID, "carol")
	if err != nil {
		t.Fatalf("AssignHumanTask() error = %v", err)
	}
	if assigned.Assignee != "carol" || assigned.Status != HumanTaskStatusPending {
		t.Errorf("AssignHumanTask() = %+v, want assignee=carol, status unchanged (pending)", assigned)
	}

	claimed, err := s.UpdateHumanTaskStatus(assigned.ID, assigned.RowVersion, HumanTaskStatusClaimed, "", "")
	if err != nil {
		t.Fatalf("UpdateHumanTaskStatus(pending->claimed) error = %v", err)
	}

	approved, err := s.UpdateHumanTaskStatus(claimed.ID, claimed.RowVersion, HumanTaskStatusApproved, "approve", "looks good")
	if err != nil {
		t.Fatalf("UpdateHumanTaskStatus(claimed->approved) error = %v", err)
	}
	if approved.Decision != "approve" || approved.Comment != "looks good" || approved.CompletedAt == nil {
		t.Errorf("UpdateHumanTaskStatus() to approved = %+v, unexpected", approved)
	}

	// Terminal: kein weiterer Übergang mehr erlaubt.
	if _, err := s.UpdateHumanTaskStatus(approved.ID, approved.RowVersion, HumanTaskStatusRejected, "", ""); err == nil {
		t.Fatalf("UpdateHumanTaskStatus() from terminal state error = nil, want error")
	}

	byExecution, err := s.ListHumanTasksByExecution(e.ID)
	if err != nil {
		t.Fatalf("ListHumanTasksByExecution() error = %v", err)
	}
	if len(byExecution) != 1 {
		t.Fatalf("ListHumanTasksByExecution() = %d entries, want 1", len(byExecution))
	}

	byAssignee, err := s.ListHumanTasksByAssignee("carol")
	if err != nil {
		t.Fatalf("ListHumanTasksByAssignee() error = %v", err)
	}
	if len(byAssignee) != 1 {
		t.Fatalf("ListHumanTasksByAssignee() = %d entries, want 1", len(byAssignee))
	}
}

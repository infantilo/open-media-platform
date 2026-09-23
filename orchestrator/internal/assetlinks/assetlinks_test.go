package assetlinks

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

// testDB liefert eine isolierte, migrierte Testdatenbank (dbtest.Open,
// docs/decisions.md Nachtrag 108/270) und räumt process_executions
// sowie assets vor/nach jedem Test auf — process_execution_asset_links
// cascadiert über beide Fremdschlüssel, ein Aufräumen der Basistabellen
// reicht.
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM process_executions`); err != nil {
			t.Fatalf("cleanup process_executions: %v", err)
		}
		if _, err := database.Exec(`DELETE FROM assets`); err != nil {
			t.Fatalf("cleanup assets: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

// seedExecution legt eine minimale, aber vollständige ProcessDefinition/
// -Version/-Execution an, um eine echte process_execution_id für die
// FK-Beziehung zu bekommen (kein Insert am Store vorbei — echte
// Fremdschlüssel-Gültigkeit ist gerade der Punkt dieses Pakets).
func seedExecution(t *testing.T, database *sql.DB) process.ProcessExecution {
	t.Helper()
	ps := process.NewStore(database)
	pd, err := ps.CreateDefinition("assetlinks test", "", "", "tester")
	if err != nil {
		t.Fatalf("CreateDefinition() error = %v", err)
	}
	v, err := ps.CreateVersion(pd.ID, process.Definition{
		StartStepID: "s1",
		Steps:       []process.Step{{ID: "s1", Type: process.StepTypeWait, Name: "wait"}},
	}, "tester")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	if _, err := ps.PublishVersion(v.ID); err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}
	exec, err := ps.CreateExecution(process.CreateExecutionParams{ProcessDefinitionID: pd.ID, ProcessVersionID: v.ID, CreatedBy: "tester"})
	if err != nil {
		t.Fatalf("CreateExecution() error = %v", err)
	}
	return exec
}

func seedAssetVersion(t *testing.T, database *sql.DB) asset.AssetVersion {
	t.Helper()
	as := asset.NewStore(database)
	a, err := as.CreateAsset("video", "assetlinks test asset", "", "tester")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}
	v, err := as.CreateVersion(a.ID, "", "", "tester")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	return v
}

func TestCreateLinkAndListByExecution(t *testing.T) {
	database := testDB(t)
	exec := seedExecution(t, database)
	v1 := seedAssetVersion(t, database)
	v2 := seedAssetVersion(t, database)
	s := NewStore(database)

	if _, err := s.CreateLink(exec.ID, v1.ID, "input"); err != nil {
		t.Fatalf("CreateLink(input) error = %v", err)
	}
	if _, err := s.CreateLink(exec.ID, v2.ID, "output"); err != nil {
		t.Fatalf("CreateLink(output) error = %v", err)
	}

	links, err := s.ListByExecution(exec.ID)
	if err != nil {
		t.Fatalf("ListByExecution() error = %v", err)
	}
	if len(links) != 2 {
		t.Fatalf("ListByExecution() = %+v, want 2 entries", links)
	}
	roles := map[string]bool{}
	for _, l := range links {
		roles[l.Role] = true
	}
	if !roles["input"] || !roles["output"] {
		t.Errorf("ListByExecution() roles = %+v, want input+output", roles)
	}
}

func TestCreateLinkIsIdempotent(t *testing.T) {
	database := testDB(t)
	exec := seedExecution(t, database)
	v := seedAssetVersion(t, database)
	s := NewStore(database)

	first, err := s.CreateLink(exec.ID, v.ID, "input")
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}
	// Retry desselben Schritts (A4) verlinkt dieselbe AssetVersion in
	// derselben Rolle erneut — muss dieselbe Zeile liefern, kein Konflikt.
	second, err := s.CreateLink(exec.ID, v.ID, "input")
	if err != nil {
		t.Fatalf("re-CreateLink() error = %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("re-CreateLink() id = %s, want same id %s (idempotent)", second.ID, first.ID)
	}

	links, err := s.ListByExecution(exec.ID)
	if err != nil {
		t.Fatalf("ListByExecution() error = %v", err)
	}
	if len(links) != 1 {
		t.Fatalf("ListByExecution() = %+v, want exactly 1 entry (idempotent)", links)
	}
}

func TestListByAssetVersionAndDelete(t *testing.T) {
	database := testDB(t)
	exec1 := seedExecution(t, database)
	exec2 := seedExecution(t, database)
	v := seedAssetVersion(t, database)
	s := NewStore(database)

	if _, err := s.CreateLink(exec1.ID, v.ID, "output"); err != nil {
		t.Fatalf("CreateLink(exec1) error = %v", err)
	}
	link2, err := s.CreateLink(exec2.ID, v.ID, "input")
	if err != nil {
		t.Fatalf("CreateLink(exec2) error = %v", err)
	}

	links, err := s.ListByAssetVersion(v.ID)
	if err != nil {
		t.Fatalf("ListByAssetVersion() error = %v", err)
	}
	if len(links) != 2 {
		t.Fatalf("ListByAssetVersion() = %+v, want 2 entries (both executions)", links)
	}

	if err := s.DeleteLink(link2.ID); err != nil {
		t.Fatalf("DeleteLink() error = %v", err)
	}
	links, err = s.ListByAssetVersion(v.ID)
	if err != nil {
		t.Fatalf("ListByAssetVersion() after delete error = %v", err)
	}
	if len(links) != 1 {
		t.Fatalf("ListByAssetVersion() after delete = %+v, want 1 entry", links)
	}
	// Idempotent.
	if err := s.DeleteLink(link2.ID); err != nil {
		t.Errorf("second DeleteLink() error = %v, want nil (idempotent)", err)
	}
}

func TestCreateLinkRequiresAllFields(t *testing.T) {
	database := testDB(t)
	exec := seedExecution(t, database)
	v := seedAssetVersion(t, database)
	s := NewStore(database)

	cases := []struct {
		name, execID, versionID, role string
	}{
		{"missing execution", "", v.ID, "input"},
		{"missing version", exec.ID, "", "input"},
		{"missing role", exec.ID, v.ID, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := s.CreateLink(c.execID, c.versionID, c.role); !errors.Is(err, ErrValidation) {
				t.Errorf("CreateLink() error = %v, want ErrValidation", err)
			}
		})
	}
}

// TestCreateLinkUnknownExecutionOrVersionFails — der eigentliche Sinn
// dieses Pakets: echte Fremdschlüssel, kein bloßer String-Verweis.
func TestCreateLinkUnknownExecutionOrVersionFails(t *testing.T) {
	database := testDB(t)
	exec := seedExecution(t, database)
	v := seedAssetVersion(t, database)
	s := NewStore(database)

	if _, err := s.CreateLink("ghost-execution", v.ID, "input"); err == nil {
		t.Error("CreateLink() with unknown execution id: want FK violation error, got nil")
	}
	if _, err := s.CreateLink(exec.ID, "ghost-version", "input"); err == nil {
		t.Error("CreateLink() with unknown asset version id: want FK violation error, got nil")
	}
}

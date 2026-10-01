package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

type fakeRunReader struct {
	runs  []workflows.Run
	since time.Time
	from  time.Time
	to    time.Time
}

func (f *fakeRunReader) List(from, to time.Time) ([]workflows.Run, error) {
	f.from, f.to = from, to
	return f.runs, nil
}
func (f *fakeRunReader) TrackingSince() (time.Time, error) { return f.since, nil }

func TestHandleWorkflowRuns(t *testing.T) {
	end := time.Now()
	rr := &fakeRunReader{
		since: end.Add(-48 * time.Hour),
		runs: []workflows.Run{
			{ID: 1, WorkflowID: "w1", WorkflowName: "A", StartedAt: end.Add(-2 * time.Hour), EndedAt: &end, StartSource: "schedule", EndReason: "manual"},
			{ID: 2, WorkflowID: "gelöscht", WorkflowName: "weg", StartedAt: end.Add(-time.Hour), StartSource: "manual"},
		},
	}
	svc := fakeWorkflowService{list: []workflows.Workflow{{ID: "w1", Name: "A"}}}
	h := handleWorkflowRuns(rr, svc)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/api/v1/workflows/runs?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	var resp workflowRunsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// nur Läufe von (sichtbaren) vorhandenen Workflows, mit Aufzeichnungsbeginn
	if len(resp.Runs) != 1 || resp.Runs[0].WorkflowID != "w1" || resp.TrackingSince == nil {
		t.Errorf("resp = %+v", resp)
	}
	if rr.from.Format(time.RFC3339) != "2026-10-01T00:00:00Z" || rr.to.Format(time.RFC3339) != "2026-10-02T00:00:00Z" {
		t.Errorf("Zeitraum nicht durchgereicht: %v – %v", rr.from, rr.to)
	}

	bad := httptest.NewRecorder()
	h(bad, httptest.NewRequest(http.MethodGet, "/api/v1/workflows/runs?from=gestern", nil))
	if bad.Code != http.StatusBadRequest {
		t.Errorf("ungültiges from = %d, want 400", bad.Code)
	}

	// ohne Historie (nil): leere Liste statt Fehler
	none := httptest.NewRecorder()
	handleWorkflowRuns(nil, svc)(none, httptest.NewRequest(http.MethodGet, "/", nil))
	if none.Code != http.StatusOK {
		t.Errorf("ohne Reader = %d", none.Code)
	}
}

package httpapi

import (
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// WorkflowRunReader liefert die Lauf-Historie (*workflows.RunStore).
type WorkflowRunReader interface {
	List(from, to time.Time) ([]workflows.Run, error)
	TrackingSince() (time.Time, error)
}

type workflowRunsResponse struct {
	// TrackingSince: ab hier gibt es Aufzeichnungen (leer: noch keine). Davor
	// zeigt der Scheduler den Plan, weil dort schlicht nichts bekannt ist.
	TrackingSince *time.Time      `json:"trackingSince,omitempty"`
	Runs          []workflows.Run `json:"runs"`
}

// handleWorkflowRuns: GET /api/v1/workflows/runs?from=<RFC3339>&to=<RFC3339>.
// Nur Läufe von Workflows der eigenen Organisation (wie die Workflow-Liste);
// ohne from/to: die letzten 24 Stunden.
func handleWorkflowRuns(runs WorkflowRunReader, svc WorkflowService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := workflowRunsResponse{Runs: []workflows.Run{}}
		if runs == nil {
			writeJSON(w, http.StatusOK, resp)
			return
		}
		now := time.Now()
		from, to := now.Add(-24*time.Hour), now.Add(time.Hour)
		if v := r.URL.Query().Get("from"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				http.Error(w, "from: erwartet RFC3339", http.StatusBadRequest)
				return
			}
			from = t
		}
		if v := r.URL.Query().Get("to"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				http.Error(w, "to: erwartet RFC3339", http.StatusBadRequest)
				return
			}
			to = t
		}
		list, err := svc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		visible := map[string]bool{}
		for _, wf := range list {
			if orgMatches(r, wf.OwnerOrgID) {
				visible[wf.ID] = true
			}
		}
		all, err := runs.List(from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, run := range all {
			if visible[run.WorkflowID] {
				resp.Runs = append(resp.Runs, run)
			}
		}
		if t, err := runs.TrackingSince(); err == nil && !t.IsZero() {
			resp.TrackingSince = &t
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

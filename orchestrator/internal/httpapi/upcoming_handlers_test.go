package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

type upcomingAuthz struct {
	fakeAuthzSvc
	ids map[string][]string
}

func (u upcomingAuthz) WorkflowIDsFor(subject string, _ authz.Verb) ([]string, error) {
	return u.ids[subject], nil
}

func TestMeUpcomingListsOnlyOperatorsOwnNotYetRunningWorkflowsEarliestFirst(t *testing.T) {
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	daily := func(hhmm string) workflows.Definition {
		return workflows.Definition{Schedules: []workflows.Schedule{{Kind: workflows.ScheduleDaily, Action: workflows.ScheduleActionStart, TimeOfDay: hhmm}}}
	}
	svc := &fakeWorkflowService{list: []workflows.Workflow{
		{ID: "late", Name: "Spät", Status: workflows.StatusStopped, Definition: daily("22:00")},
		{ID: "soon", Name: "Bald", Status: workflows.StatusStopped, Definition: daily("11:00")},
		{ID: "running", Name: "Läuft", Status: workflows.StatusStarted, Definition: daily("11:30")},
		{ID: "foreign", Name: "Fremd", Status: workflows.StatusStopped, Definition: daily("10:30")},
		{ID: "noplan", Name: "Ohne Plan", Status: workflows.StatusStopped},
	}}
	az := upcomingAuthz{ids: map[string][]string{"op": {"late", "soon", "running", "noplan"}}}
	h := handleMeUpcoming(svc, az, func() time.Time { return now })

	call := func(user string) []upcomingStart {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/me/upcoming", nil)
		if user != "" {
			req = withPrincipal(req, user)
		}
		h(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		var out []upcomingStart
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	got := call("op")
	if len(got) != 2 || got[0].WorkflowID != "soon" || got[1].WorkflowID != "late" {
		t.Fatalf("erwartet [soon, late], bekam %+v", got)
	}
	if !got[0].StartsAt.Equal(time.Date(2026, 10, 2, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("falscher Zeitpunkt %v", got[0].StartsAt)
	}
	if n := len(call("niemand")); n != 0 {
		t.Fatalf("Nutzer ohne Bindung sieht nichts, bekam %d", n)
	}
	if n := len(call("")); n != 0 {
		t.Fatalf("ohne Anmeldung (Bootstrap) leer, bekam %d", n)
	}
}

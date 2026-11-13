package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkflowStateHoldHandlers(t *testing.T) {
	svc := fakeWorkflowService{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/workflows/{id}/state-holds", handleWorkflowStateHolds(svc))
	mux.HandleFunc("POST /api/v1/workflows/{id}/roles/{role}/state-hold", handleWorkflowStateHoldAction(svc))
	mux.HandleFunc("POST /api/v1/workflows/{id}/roles/{role}/rearm-standby", handleRearmStandby(svc))

	do := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	if rec := do("GET", "/api/v1/workflows/wf1/state-holds", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"mix"`) {
		t.Fatalf("state-holds = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("POST", "/api/v1/workflows/wf1/roles/mix/state-hold", `{"action":"restore"}`); rec.Code != http.StatusOK {
		t.Fatalf("restore = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("POST", "/api/v1/workflows/wf1/roles/other/state-hold", `{"action":"restore"}`); rec.Code != http.StatusConflict {
		t.Fatalf("restore without a held state = %d, want 409", rec.Code)
	}
	if rec := do("POST", "/api/v1/workflows/wf1/roles/mix/state-hold", `{"action":"discard"}`); rec.Code != http.StatusOK {
		t.Fatalf("discard = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("POST", "/api/v1/workflows/wf1/roles/mix/state-hold", `{"action":"x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown action = %d, want 400", rec.Code)
	}
	if rec := do("POST", "/api/v1/workflows/wf1/roles/mix/rearm-standby", ""); rec.Code != http.StatusAccepted {
		t.Fatalf("rearm-standby = %d, want 202", rec.Code)
	}
}

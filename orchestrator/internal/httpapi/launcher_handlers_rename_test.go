package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlePatchInstanceRejectsEmptyLabel(t *testing.T) {
	h := handlePatchInstance(fakeLauncherService{}, nil, nil)
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/instances/i1", strings.NewReader(`{"label":"  "}`))
	req.SetPathValue("id", "i1")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

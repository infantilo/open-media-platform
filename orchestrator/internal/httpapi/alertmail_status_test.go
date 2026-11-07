package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
)

func TestAlertStatusPreview(t *testing.T) {
	f := func(a alertsink.Alert) *alertsink.StatusReport {
		return &alertsink.StatusReport{Orchestrator: alertsink.OrchestratorInfo{Name: "o1"},
			Flow: alertsink.UpstreamOf("n", nil, map[string]string{"n": "Node"}, map[string]bool{"n": true})}
	}
	rec := httptest.NewRecorder()
	handleAlertStatusPreview(f)(rec, httptest.NewRequest("POST", "/x", strings.NewReader(`{}`)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Orchestrator: o1") || !strings.Contains(rec.Body.String(), `"png":"iVBOR`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleAlertStatusPreview(nil)(rec, httptest.NewRequest("POST", "/x", nil))
	if rec.Code != 501 {
		t.Fatal(rec.Code)
	}
}

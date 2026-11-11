package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTestTriggerFilter(t *testing.T) {
	for _, c := range []struct{ body, want string }{
		{`{"filter":"input.severity == \"critical\"","payload":{"severity":"critical"}}`, `"result":true`},
		{`{"filter":"input.severity == \"critical\"","payload":{"severity":"info"}}`, `"result":false`},
		{`{"filter":"input.x ==","payload":{}}`, `"ok":false`},
	} {
		rec := httptest.NewRecorder()
		handleTestTriggerFilter()(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(c.body)))
		if !strings.Contains(rec.Body.String(), c.want) {
			t.Errorf("%s → %s, erwartet %s", c.body, rec.Body.String(), c.want)
		}
	}
}

package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/timeline"
)

type recHub struct{ got []string }

func (h *recHub) Subscribe() (<-chan sse.Event, func()) { return nil, func() {} }
func (h *recHub) Broadcast(e sse.Event)                 { h.got = append(h.got, e.Type) }
func (h *recHub) ClientCount() int                      { return 0 }
func (h *recHub) TotalDrops() uint64                    { return 0 }

type stubAudit struct{}

func (stubAudit) ListFiltered(audit.Filter) ([]audit.Entry, error) {
	return []audit.Entry{{ID: 1, OccurredAt: time.Now(), Username: "anna", Method: "POST", Path: "/api/v1/instances", Status: 200}}, nil
}

func TestTimelineMarkerAndRead(t *testing.T) {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE timeline_events`); err != nil {
		t.Fatal(err)
	}
	src := &timeline.Sources{Store: timeline.NewStore(db), Audit: stubAudit{}}
	hub := &recHub{}
	mark := handlePostTimelineMarker(src, hub)

	rec := httptest.NewRecorder()
	mark(rec, withPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/timeline/marker", strings.NewReader(`{"note":"  Ton weg  "}`)), "anna"))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code, rec.Body.String())
	}
	// Doppelklick innerhalb der Sperrzeit: kein zweiter Marker
	rec = httptest.NewRecorder()
	mark(rec, withPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/timeline/marker", nil), "anna"))
	if !strings.Contains(rec.Body.String(), `"duplicate":true`) {
		t.Fatalf("Doppelklick: %s", rec.Body.String())
	}
	// Anderer Nutzer: eigener Marker
	rec = httptest.NewRecorder()
	mark(rec, withPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/timeline/marker", nil), "bob"))
	if rec.Code != http.StatusOK || len(hub.got) != 2 || hub.got[0] != "timeline.appended" {
		t.Fatalf("code %d, events %v", rec.Code, hub.got)
	}

	rec = httptest.NewRecorder()
	handleTimeline(src)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/timeline?limit=10", nil))
	var out struct {
		Items []timeline.Item `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("%d %v %s", rec.Code, err, rec.Body.String())
	}
	var markers, audits int
	var note string
	for _, it := range out.Items {
		switch it.Kind {
		case "marker":
			markers++
			if it.Actor == "anna" {
				var d struct{ Note string }
				_ = json.Unmarshal(it.Data, &d)
				note = d.Note
			}
		case "audit":
			audits++
		}
	}
	if markers != 2 || audits != 1 || note != "Ton weg" {
		t.Fatalf("markers %d, audits %d, note %q", markers, audits, note)
	}

	for _, q := range []string{"since=2026-10-27T10:00:00Z&until=2026-10-27T09:00:00Z"} {
		rec = httptest.NewRecorder()
		handleTimeline(src)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/timeline?"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", q, rec.Code)
		}
	}
}

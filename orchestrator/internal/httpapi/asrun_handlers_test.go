package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeAsRun struct {
	mu   sync.Mutex
	recs []asrun.Record
	ch   string
}

func (f *fakeAsRun) Upsert(_ context.Context, ch string, r []asrun.Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ch = ch
	f.recs = append(f.recs, r...)
	return nil
}
func (f *fakeAsRun) List(_ context.Context, _ asrun.Filter) ([]asrun.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]asrun.Record(nil), f.recs...), nil
}

type nodeByID struct{ fakeNodeLister }

func (nodeByID) Get(id string) (registry.NodeView, bool) {
	return registry.NodeView{ID: id, InstanceID: "inst-1"}, true
}

func TestPostAsRunNeedsChannelAccessAndStoresRecords(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Name: "National", Instance: "inst-1"}}
	st := &fakeAsRun{}
	h := handlePostAsRun(st, svc, fakeVerbs{operate: map[string]bool{"bob": true}}, nil)
	body := `{"records":[{"key":"e1#1","kind":"primary","status":"RUNNING"}]}`
	w := httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", body, "inst-1"))
	if w.Code != http.StatusOK || len(st.recs) != 1 || st.ch != "ch1" {
		t.Fatalf("gebundene Instanz: %d %s %+v", w.Code, w.Body, st.recs)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", body, "inst-2"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("fremde Instanz muss verweigert werden: %d", w.Code)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{kaputt`, "inst-1"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("JSON: %d", w.Code)
	}
}

func TestGetAsRunJSONAndCSV(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1"}}
	st := &fakeAsRun{recs: []asrun.Record{{ChannelID: "ch1", Key: "k", Kind: asrun.KindPrimary, Label: "Clip", Status: "COMPLETED"}}}
	h := handleGetAsRun(st, svc)
	w := httptest.NewRecorder()
	h(w, playoutReq("GET", "/x?kind=primary", "", "bob"))
	var out []asrun.Record
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out) != 1 {
		t.Fatalf("JSON: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("GET", "/x?format=csv", "", "bob"))
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/csv") || !strings.Contains(w.Body.String(), "Clip") {
		t.Fatalf("CSV: %s %s", w.Header(), w.Body)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("GET", "/x?from=gestern", "", "bob"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("ungültige Zeit: %d", w.Code)
	}
}

func TestOperatorTapRecordsWhoDidWhatOnlyOnSuccess(t *testing.T) {
	st := &fakeAsRun{}
	o := &handlerOptions{asrun: st, playout: &fakePlayout{ch: playout.Channel{ID: "ch1"}}}
	status := http.StatusOK
	next := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }
	h := asRunOperatorTap(next, o, nodeByID{})
	call := func(method string) {
		r := httptest.NewRequest("POST", "/api/v1/nodes/n1/methods/"+method, strings.NewReader(`{"itemId":"item7"}`))
		r.SetPathValue("id", "n1")
		r.SetPathValue("name", method)
		h(httptest.NewRecorder(), r)
	}
	call("take")
	call("irgendwas") // keine manuelle Aktion → nichts protokolliert
	status = http.StatusBadGateway
	call("next") // fehlgeschlagen → nichts protokolliert
	if len(st.recs) != 1 {
		t.Fatalf("genau ein Eintrag erwartet: %+v", st.recs)
	}
	r := st.recs[0]
	if r.Kind != asrun.KindOperator || r.Action != "take" || r.EventID != "item7" || st.ch != "ch1" {
		t.Fatalf("Eintrag: %+v", r)
	}
}

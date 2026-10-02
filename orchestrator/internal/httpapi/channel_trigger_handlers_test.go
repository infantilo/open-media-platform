package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/channeltrigger"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

type fakeTriggerSvc struct {
	sentFrom playout.Channel
	sentReq  channeltrigger.Request
	result   []channeltrigger.Delivery
	err      error
	ackArgs  []string
}

func (f *fakeTriggerSvc) Send(origin playout.Channel, req channeltrigger.Request, _ string) ([]channeltrigger.Delivery, error) {
	f.sentFrom, f.sentReq = origin, req
	return f.result, f.err
}
func (f *fakeTriggerSvc) Ack(ch, id, status, detail, _ string) (channeltrigger.Record, error) {
	f.ackArgs = []string{ch, id, status, detail}
	return channeltrigger.Record{ID: id, Status: status}, f.err
}

func TestSendChannelTriggerAccessAndStatusCodes(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Name: "National", Instance: "inst-1"}}
	verbs := fakeVerbs{operate: map[string]bool{"bob": true}}
	trig := &fakeTriggerSvc{result: []channeltrigger.Delivery{{ID: "t1", TargetChannel: "n", Status: channeltrigger.StatusPublished}}}
	h := handleSendChannelTrigger(trig, svc, verbs, nil)
	body := `{"event":"NEXT_LIVE","target":{"group":"regional"},"latePolicy":"SKIP"}`

	for _, c := range []struct {
		name, user string
		want       int
	}{{"gebundene Instanz", "inst-1", http.StatusAccepted}, {"Operator", "bob", http.StatusAccepted}, {"fremde Instanz", "inst-2", http.StatusForbidden}} {
		w := httptest.NewRecorder()
		h(w, playoutReq("POST", "/x", body, c.user))
		if w.Code != c.want {
			t.Errorf("%s: %d %s", c.name, w.Code, w.Body)
		}
	}
	if trig.sentFrom.ID != "ch1" || trig.sentReq.Event != "NEXT_LIVE" || trig.sentReq.Target.Group != "regional" || trig.sentReq.LatePolicy != "SKIP" {
		t.Fatalf("Request nicht durchgereicht: %+v %+v", trig.sentFrom, trig.sentReq)
	}

	// Alle Ziele verweigert → 403 mit den Zustellungen im Body (nichts wurde zugestellt).
	trig.result = []channeltrigger.Delivery{{ID: "t2", Status: channeltrigger.StatusDenied}, {ID: "t3", Status: channeltrigger.StatusDenied}}
	w := httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", body, "bob"))
	var resp struct{ Deliveries []channeltrigger.Delivery }
	if w.Code != http.StatusForbidden || json.Unmarshal(w.Body.Bytes(), &resp) != nil || len(resp.Deliveries) != 2 {
		t.Fatalf("alle verweigert: %d %s", w.Code, w.Body)
	}
	// Teilweise erlaubt → 202.
	trig.result = []channeltrigger.Delivery{{Status: channeltrigger.StatusDenied}, {Status: channeltrigger.StatusPublished}}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", body, "bob"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("teilweise: %d", w.Code)
	}
	// Validierungsfehler → 400, kaputtes JSON → 400.
	trig.err, trig.result = channeltrigger.ErrValidation, nil
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", body, "bob"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("Validierung: %d", w.Code)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{kaputt`, "bob"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("JSON: %d", w.Code)
	}
}

func TestAckChannelTriggerUsesTheAuthorizedChannelNotABodyField(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Name: "Nord", Instance: "inst-1"}}
	trig := &fakeTriggerSvc{}
	h := handleAckChannelTrigger(trig, svc, fakeVerbs{}, nil)
	w := httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{"id":"t1","status":"applied","detail":"ok","channel":"anderer"}`, "inst-1"))
	if w.Code != http.StatusOK || trig.ackArgs[0] != "ch1" || trig.ackArgs[1] != "t1" || trig.ackArgs[2] != "applied" {
		t.Fatalf("%d %v", w.Code, trig.ackArgs)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{"id":"t1","status":"applied"}`, "inst-2"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("fremde Instanz darf nicht quittieren: %d", w.Code)
	}
	w = httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{"status":"applied"}`, "inst-1"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("ohne id: %d", w.Code)
	}
}

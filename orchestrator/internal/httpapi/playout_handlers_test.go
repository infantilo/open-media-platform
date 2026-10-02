package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

type fakePlayout struct {
	ch      playout.Channel
	version int64
	execs   map[string]bool
}

func (f *fakePlayout) CreateChannel(playout.ChannelInput, string) (playout.Channel, error) {
	return f.ch, nil
}
func (f *fakePlayout) GetChannel(id string) (playout.Channel, error) {
	if id != f.ch.ID {
		return playout.Channel{}, playout.ErrNotFound
	}
	return f.ch, nil
}
func (f *fakePlayout) ChannelByInstance(string) (playout.Channel, error) { return f.ch, nil }
func (f *fakePlayout) ListChannels() ([]playout.Channel, error)          { return []playout.Channel{f.ch}, nil }
func (f *fakePlayout) UpdateChannel(string, playout.ChannelInput) (playout.Channel, error) {
	return f.ch, nil
}
func (f *fakePlayout) DeleteChannel(string) error { return nil }
func (f *fakePlayout) GetState(string) (playout.State, error) {
	return playout.State{}, playout.ErrNotFound
}
func (f *fakePlayout) PutState(_ string, expected int64, st json.RawMessage) (playout.State, error) {
	if expected != f.version {
		return playout.State{}, playout.ErrConflict
	}
	f.version++
	return playout.State{ChannelID: f.ch.ID, Version: f.version, State: st}, nil
}
func (f *fakePlayout) RecordExecution(_, id, _ string) (bool, error) {
	if f.execs == nil {
		f.execs = map[string]bool{}
	}
	first := !f.execs[id]
	f.execs[id] = true
	return first, nil
}

type fakeVerbs struct{ operate map[string]bool }

func (f fakeVerbs) Check(subject, _ string, min authz.Verb) (bool, error) {
	return f.operate[subject] && authz.VerbOperate.Covers(min), nil
}

func playoutReq(method, target, body, user string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.SetPathValue("id", "ch1")
	if user != "" {
		r = r.WithContext(context.WithValue(r.Context(), principalContextKey{}, auth.Principal{Username: user}))
	}
	return r
}

func TestPlayoutStateAccessRules(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Name: "National", Instance: "inst-1"}}
	verbs := fakeVerbs{operate: map[string]bool{"bob": true}}
	put := handlePutPlayoutState(svc, verbs)

	cases := []struct {
		name string
		user string
		want int
	}{
		{"bound instance", "inst-1", http.StatusOK},
		{"operator", "bob", http.StatusOK},
		{"foreign instance", "inst-2", http.StatusForbidden},
	}
	for _, c := range cases {
		svc.version = 0
		w := httptest.NewRecorder()
		put(w, playoutReq("PUT", "/x?version=0", `{"n":1}`, c.user))
		if w.Code != c.want {
			t.Errorf("%s: status = %d, want %d (%s)", c.name, w.Code, c.want, w.Body.String())
		}
	}
}

func TestPlayoutStateVersionConflictAndValidation(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Instance: "inst-1"}}
	put := handlePutPlayoutState(svc, fakeVerbs{})

	w := httptest.NewRecorder()
	put(w, playoutReq("PUT", "/x?version=0", `{"n":1}`, "inst-1"))
	if w.Code != http.StatusOK {
		t.Fatalf("first put = %d", w.Code)
	}
	w = httptest.NewRecorder()
	put(w, playoutReq("PUT", "/x?version=0", `{"n":2}`, "inst-1"))
	if w.Code != http.StatusConflict {
		t.Errorf("stale version = %d, want 409", w.Code)
	}
	w = httptest.NewRecorder()
	put(w, playoutReq("PUT", "/x", `{}`, "inst-1"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing version = %d, want 400", w.Code)
	}
	w = httptest.NewRecorder()
	put(w, playoutReq("PUT", "/x?version=-1", `{}`, "inst-1"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("negative version = %d, want 400", w.Code)
	}
}

func TestPlayoutExecutionJournalHandler(t *testing.T) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Instance: "inst-1"}}
	rec := handleRecordPlayoutExecution(svc, fakeVerbs{})
	for i, want := range []bool{true, false} {
		w := httptest.NewRecorder()
		rec(w, playoutReq("POST", "/x", `{"executionId":"e1","kind":"fixtime"}`, "inst-1"))
		var got map[string]bool
		_ = json.NewDecoder(w.Body).Decode(&got)
		if w.Code != http.StatusOK || got["first"] != want {
			t.Errorf("call %d: %d %v, want first=%v", i, w.Code, got, want)
		}
	}
	w := httptest.NewRecorder()
	rec(w, playoutReq("POST", "/x", `{"executionId":"e2"}`, "inst-9"))
	if w.Code != http.StatusForbidden {
		t.Errorf("foreign instance = %d, want 403", w.Code)
	}
}

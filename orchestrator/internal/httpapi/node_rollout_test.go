package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/instancemigrate"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

type prodLauncher struct {
	fakeLauncherService
	productive string
}

func (p prodLauncher) ProductiveVersion(string) string { return p.productive }

type fakeRestarter struct {
	mu      sync.Mutex
	order   []string
	outcome map[string]error
	rolled  map[string]bool
	gate    chan struct{}
}

func (f *fakeRestarter) RestartInPlace(_ context.Context, id string) (instancemigrate.RestartResult, error) {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	f.order = append(f.order, id)
	f.mu.Unlock()
	res := instancemigrate.RestartResult{OldInstanceID: id, NewInstanceID: "new-" + id, Reconnected: 2, RolledBack: f.rolled[id]}
	return res, f.outcome[id]
}

func rolloutFixture(productive string) prodLauncher {
	return prodLauncher{productive: productive, fakeLauncherService: fakeLauncherService{
		catalog: []launcher.CatalogEntry{{Type: "audio-mixer", Runner: "process", Command: []string{"/x/omp-mixer"}}},
		instances: []launcher.Instance{
			{ID: "a", Type: "audio-mixer", Label: "A", PID: 1, NodeVersion: "1.0"},
			{ID: "b", Type: "audio-mixer", Label: "B", PID: 2, NodeVersion: "1.0"},
			{ID: "c", Type: "audio-mixer", Label: "C", PID: 3, NodeVersion: "1.0"},
			{ID: "done", Type: "audio-mixer", Label: "Schon neu", PID: 4, NodeVersion: "2.0"},
			{ID: "remote", Type: "audio-mixer", Label: "Remote", PID: 5, HostID: "h1", NodeVersion: "1.0"},
			{ID: "other", Type: "omp-scope", Label: "Anderer Typ", PID: 6},
		},
	}}
}

func startRollout(t *testing.T, m *RolloutManager, svc LauncherService, r InstanceRestarter, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/r", strings.NewReader(body))
	req.SetPathValue("name", "omp-mixer")
	handleStartNodeRollout(m, svc, nil, r, nil)(rec, req)
	return rec
}

func waitDone(t *testing.T, m *RolloutManager) *rolloutStatus {
	t.Helper()
	for i := 0; i < 200; i++ {
		if st := m.snapshot(); st != nil && !st.Running {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Rollout wurde nicht fertig")
	return nil
}

func TestRolloutDryRunPlansOnlyLocalInstancesNotOnTheTargetVersion(t *testing.T) {
	m := NewRolloutManager()
	rec := startRollout(t, m, rolloutFixture("2.0"), &fakeRestarter{}, `{"dryRun":true}`)
	var plan rolloutStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &plan); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if len(plan.Items) != 3 || plan.Target != "2.0" {
		t.Fatalf("a,b,c erwartet (nicht: schon neu, Remote, anderer Typ): %+v", plan)
	}
	if m.snapshot() != nil {
		t.Fatal("Dry-Run darf keinen Rollout starten")
	}
}

func TestRolloutRunsSequentiallyAndStopsAtTheFirstFailure(t *testing.T) {
	m := NewRolloutManager()
	r := &fakeRestarter{outcome: map[string]error{"b": errors.New("kaputt")}, rolled: map[string]bool{"b": true}}
	if rec := startRollout(t, m, rolloutFixture("2.0"), r, `{"confirm":true}`); rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	st := waitDone(t, m)
	if strings.Join(r.order, ",") != "a,b" {
		t.Fatalf("nacheinander bis zum Fehler: %v", r.order)
	}
	states := []string{st.Items[0].State, st.Items[1].State, st.Items[2].State}
	if states[0] != rolloutOK || states[1] != rolloutRolledBack || states[2] != rolloutSkipped {
		t.Fatalf("Zustände: %v", states)
	}
	if st.Items[0].NewInstanceID != "new-a" {
		t.Fatalf("%+v", st.Items[0])
	}
}

func TestRolloutRefusesWithoutConfirmWhenNothingToDoAndWhileRunning(t *testing.T) {
	m := NewRolloutManager()
	if rec := startRollout(t, m, rolloutFixture("2.0"), &fakeRestarter{}, `{}`); rec.Code != 400 {
		t.Fatalf("ohne confirm: %d", rec.Code)
	}
	if rec := startRollout(t, m, rolloutFixture("2.0"), &fakeRestarter{}, `{"confirm":true,"instanceIds":["done"]}`); rec.Code != 409 {
		t.Fatalf("nichts zu tun: %d", rec.Code)
	}
	gate := make(chan struct{})
	r := &fakeRestarter{gate: gate}
	if rec := startRollout(t, m, rolloutFixture("2.0"), r, `{"confirm":true}`); rec.Code != 202 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := startRollout(t, m, rolloutFixture("2.0"), r, `{"confirm":true}`); rec.Code != 409 {
		t.Fatalf("zweiter Rollout parallel muss 409 liefern: %d", rec.Code)
	}
	close(gate)
	waitDone(t, m)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/g", nil)
	req.SetPathValue("name", "omp-mixer")
	handleGetNodeRollout(m)(rec, req)
	var st rolloutStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil || st.Running || len(st.Items) != 3 || st.Items[2].State != rolloutOK {
		t.Fatalf("Status: %v %s", err, rec.Body)
	}
}

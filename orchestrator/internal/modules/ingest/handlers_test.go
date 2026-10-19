package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type route struct {
	auth module.Auth
	h    http.HandlerFunc
}
type fakeRoutes map[string]route

func (f fakeRoutes) Handle(p string, a module.Auth, h http.HandlerFunc) { f[p] = route{a, h} }

type memSettings struct{ m map[string][]byte }

func (s *memSettings) Get(k string) ([]byte, error) {
	if v, ok := s.m[k]; ok {
		return v, nil
	}
	return nil, module.ErrNotFound
}
func (s *memSettings) Put(k string, v []byte) error { s.m[k] = v; return nil }

type hEnv struct {
	*ienv
	routes fakeRoutes
	user   string // angemeldeter Nutzer der Testaufrufe (Standard „alice“)
	m      *Module
}

func newHEnv(t *testing.T) *hEnv { return newHEnvWith(t, nil) }

func newHEnvWith(t *testing.T, acc module.Access) *hEnv {
	e := newIEnv(t, nil)
	m := &Module{S: Services{Assets: e.svc.Assets, Runtime: e.rt}}
	rts := fakeRoutes{}
	set := &memSettings{m: map[string][]byte{}}
	raw, _ := json.Marshal(*e.cfg)
	set.m[settingsKey] = raw
	if err := m.Mount(rts, module.Deps{DB: e.svc.St.db, Settings: set, Audit: nopAudit{}, Access: acc}); err != nil {
		t.Fatal(err)
	}
	// Dienst des Moduls mit der Testuhr/-laufzeit verdrahten
	m.svc.Now, m.svc.Runtime = e.svc.Now, e.rt
	m.svc.Hosts = e.svc.Hosts
	return &hEnv{ienv: e, routes: rts, user: "alice", m: m}
}

func (h *hEnv) call(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	p := path
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	for pat, rt := range h.routes {
		parts := strings.SplitN(pat, " ", 2)
		if parts[0] != method {
			continue
		}
		pp, qq := strings.Split(parts[1], "/"), strings.Split(p, "/")
		if len(pp) != len(qq) {
			continue
		}
		vals, ok := map[string]string{}, true
		for i := range pp {
			if strings.HasPrefix(pp[i], "{") {
				vals[strings.Trim(pp[i], "{}")] = qq[i]
			} else if pp[i] != qq[i] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		req := httptest.NewRequest(method, path, rd)
		for k, v := range vals {
			req.SetPathValue(k, v)
		}
		req = req.WithContext(module.WithUser(context.Background(), h.user))
		rec := httptest.NewRecorder()
		rt.h(rec, req)
		return rec
	}
	t.Fatalf("keine Route %s %s", method, path)
	return nil
}

func dec(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("%v: %s", err, rec.Body)
	}
	return m
}

func TestRoutePermissionsAreStrict(t *testing.T) {
	h := newHEnv(t)
	for pat, rt := range h.routes {
		method := strings.SplitN(pat, " ", 2)[0]
		if rt.auth.Kind == module.AuthAnonymous {
			t.Errorf("%s anonym", pat)
		}
		if rt.auth.Kind == module.AuthAuthenticated && method != "GET" && !strings.HasSuffix(pat, "/plan") {
			t.Errorf("%s verändert Daten, verlangt aber nur Anmeldung", pat)
		}
	}
	if rt := h.routes["PUT /api/v1/ingest/config"]; string(rt.auth.Verb) != "admin" {
		t.Errorf("config: %+v", rt.auth)
	}
	for p, feat := range map[string]string{"POST /api/v1/ingest/schedules": FeatScheduleCreate, "POST /api/v1/ingest/adhoc": FeatAdhoc,
		"POST /api/v1/ingest/jobs/{id}/cancel": FeatJobControl, "PUT /api/v1/ingest/schedules/{id}": FeatScheduleEdit} {
		if rt := h.routes[p]; rt.auth.Kind != module.AuthFeature || strings.Join(rt.auth.Features, "|") != feat {
			t.Errorf("%s: %+v", p, rt.auth)
		}
	}
	used := map[string]bool{}
	for _, rt := range h.routes {
		if rt.auth.Kind == module.AuthFeature {
			for _, f := range rt.auth.Features {
				used[f] = true
			}
		}
	}
	for _, f := range (*Module)(nil).Features() {
		if f.ID != FeatView && f.ID != FeatAssign && f.ID != FeatManageAll && !used[f.ID] {
			t.Errorf("Funktionsrecht %s wird von keiner Route verlangt", f.ID)
		}
	}
}

func TestHTTPScheduleLifecycleAndPlanDryRun(t *testing.T) {
	h := newHEnv(t)
	body := map[string]any{"name": "Nachrichten", "source": map[string]any{"instanceId": "src1", "label": "Studio"}, "profileId": "mxf-h264",
		"spec": map[string]any{"tz": "Europe/Berlin", "startLocal": "2026-10-20T20:00", "durationS": 900, "recurrence": map[string]any{"freq": "daily"}}}
	rec := h.call(t, "POST", "/api/v1/ingest/schedules", body)
	if rec.Code != 201 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	d := dec(t, rec)
	sc := d["schedule"].(map[string]any)
	if len(d["jobs"].([]any)) < 1 {
		t.Fatalf("jobs must be materialized: %v", d)
	}
	// ungültige Zeitzone → 400 mit Einzelproblem
	bad := map[string]any{"name": "x", "source": map[string]any{"instanceId": "s"}, "profileId": "mxf-h264", "spec": map[string]any{"tz": "Mars/Base", "startLocal": "2026-10-20T20:00", "durationS": 60}}
	if rec := h.call(t, "POST", "/api/v1/ingest/schedules", bad); rec.Code != 400 || len(dec(t, rec)["problems"].([]any)) == 0 {
		t.Fatalf("bad tz: %d %s", rec.Code, rec.Body)
	}
	// Trockenlauf: ein zweiter Auftrag, der den Rekorder-Slot sprengt (Budget 2) zeigt Gründe, ohne zu speichern
	st := time.Date(2026, 10, 20, 18, 5, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		in := map[string]any{"name": "adhoc", "source": map[string]any{"instanceId": "cam" + string(rune('a'+i))}, "profileId": "mxf-h264", "start": st, "durationS": 600}
		if rec := h.call(t, "POST", "/api/v1/ingest/adhoc", in); rec.Code != 201 {
			t.Fatalf("adhoc %d: %d %s", i, rec.Code, rec.Body)
		}
	}
	before, _ := h.svc.St.ListJobs(context.Background(), JobFilter{})
	plan := map[string]any{"source": map[string]any{"instanceId": "camz"}, "profileId": "mxf-h264", "start": st, "durationS": 300}
	rec = h.call(t, "POST", "/api/v1/ingest/plan", plan)
	pd := dec(t, rec)["decision"].(map[string]any)
	if rec.Code != 200 || pd["admit"] != false {
		t.Fatalf("plan: %d %s", rec.Code, rec.Body)
	}
	vs := pd["verdicts"].([]any)
	if vs[0].(map[string]any)["kind"] != VTempOccupied || pd["earliestStart"] == nil {
		t.Fatalf("verdict: %v", vs)
	}
	after, _ := h.svc.St.ListJobs(context.Background(), JobFilter{})
	if len(after) != len(before) {
		t.Fatal("a dry run must not create jobs")
	}
	// Kapazität: Nutzung je Ressource, Probleme leer (alles zugelassen)
	rec = h.call(t, "GET", "/api/v1/ingest/capacity?from=2026-10-20T10:00:00Z&to=2026-10-21T10:00:00Z", nil)
	cd := dec(t, rec)
	if rec.Code != 200 || len(cd["hosts"].([]any)) != 1 || len(cd["resources"].([]any)) < 6 {
		t.Fatalf("capacity: %d %s", rec.Code, rec.Body)
	}
	host := cd["hosts"].([]any)[0].(map[string]any)
	if len(host["usage"].([]any)) == 0 {
		t.Fatal("usage timeline expected")
	}
	// Zeitplan ändern mit veralteter Revision → 409; Löschen
	up := map[string]any{"expectedRevision": 99, "name": "N2", "source": map[string]any{"instanceId": "src1"}, "profileId": "mxf-h264", "spec": body["spec"]}
	id := sc["id"].(string)
	if rec := h.call(t, "PUT", "/api/v1/ingest/schedules/"+id, up); rec.Code != 409 {
		t.Fatalf("stale: %d", rec.Code)
	}
	if rec := h.call(t, "DELETE", "/api/v1/ingest/schedules/"+id, nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	rec = h.call(t, "GET", "/api/v1/ingest/jobs?scheduleId="+id+"&state=cancelled", nil)
	if len(dec(t, rec)["jobs"].([]any)) < 1 {
		t.Fatal("future jobs of a cancelled schedule must be cancelled")
	}
	// Vorschau-Route
	if rec := h.call(t, "GET", "/api/v1/ingest/schedules/"+id+"/preview", nil); rec.Code != 200 {
		t.Fatalf("preview: %d", rec.Code)
	}
}

func TestHTTPConfigRoundTrip(t *testing.T) {
	h := newHEnv(t)
	cfg := dec(t, h.call(t, "GET", "/api/v1/ingest/config", nil))
	cfg["leadTimeS"] = 60
	if rec := h.call(t, "PUT", "/api/v1/ingest/config", cfg); rec.Code != 200 || dec(t, rec)["leadTimeS"].(float64) != 60 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	cfg["profiles"] = map[string]any{"x": map[string]any{"id": "y", "ext": ".mxf"}}
	if rec := h.call(t, "PUT", "/api/v1/ingest/config", cfg); rec.Code != 400 {
		t.Fatalf("inconsistent profile id must be rejected: %d", rec.Code)
	}
}

// Leere Listen müssen als [] ausgeliefert werden (nicht null) — die Oberfläche verlässt sich darauf.
func TestCapacityEmptyListsAreArrays(t *testing.T) {
	h := newHEnv(t)
	rec := h.call(t, "GET", "/api/v1/ingest/capacity", nil)
	d := dec(t, rec)
	if d["jobs"] == nil || d["problems"] == nil {
		t.Fatalf("null lists: %s", rec.Body)
	}
	for _, hv := range d["hosts"].([]any) {
		m := hv.(map[string]any)
		if m["usage"] == nil || m["warnings"] == nil {
			t.Fatalf("null host lists: %v", m)
		}
	}
}

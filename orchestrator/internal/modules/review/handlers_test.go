package review

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

type httpEnv struct {
	*testEnv
	routes fakeRoutes
}

func newHTTPEnv(t *testing.T) *httpEnv {
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	m := &Module{Assets: e.svc.Assets, DataDir: e.svc.DataDir, Tools: e.svc.Tools}
	rts := fakeRoutes{}
	set := &memSettings{m: map[string][]byte{}}
	raw, _ := json.Marshal(*e.cfg)
	set.m[settingsKey] = raw
	if err := m.Mount(rts, module.Deps{DB: e.svc.St.db, Settings: set, Audit: &auditSink{}}); err != nil {
		t.Fatal(err)
	}
	return &httpEnv{testEnv: e, routes: rts}
}

func (h *httpEnv) call(t *testing.T, method, path, user string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	// passendes Muster suchen
	for pat, rt := range h.routes {
		parts := strings.SplitN(pat, " ", 2)
		if parts[0] != method {
			continue
		}
		if vals, ok := matchPattern(parts[1], path); ok {
			req := httptest.NewRequest(method, path, rdr)
			for k, v := range vals {
				req.SetPathValue(k, v)
			}
			req = req.WithContext(module.WithUser(context.Background(), user))
			rec := httptest.NewRecorder()
			rt.h(rec, req)
			return rec
		}
	}
	t.Fatalf("keine Route für %s %s", method, path)
	return nil
}

func matchPattern(pat, path string) (map[string]string, bool) {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	pp, qq := strings.Split(pat, "/"), strings.Split(path, "/")
	if len(pp) != len(qq) {
		return nil, false
	}
	vals := map[string]string{}
	for i := range pp {
		if strings.HasPrefix(pp[i], "{") {
			vals[strings.Trim(pp[i], "{}")] = qq[i]
		} else if pp[i] != qq[i] {
			return nil, false
		}
	}
	return vals, true
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	return m
}

// Kein verändernder Endpunkt darf anonym oder nur „angemeldet“ sein; Lesen verlangt Anmeldung.
func TestRoutePermissionsAreDeclaredStrictly(t *testing.T) {
	h := newHTTPEnv(t)
	for pat, rt := range h.routes {
		method := strings.SplitN(pat, " ", 2)[0]
		switch rt.auth.Kind {
		case module.AuthAnonymous:
			t.Errorf("%s ist anonym", pat)
		case module.AuthAuthenticated:
			if method != "GET" {
				t.Errorf("%s verändert Daten, verlangt aber nur Anmeldung", pat)
			}
		}
	}
	// Freigabe/Neuzuweisung/Konfiguration brauchen mehr als „operate“
	need := map[string]string{
		"POST /api/v1/review/items/{id}/approve": "review.approve", "POST /api/v1/review/items/{id}/reject": "review.approve",
		"POST /api/v1/review/items/{id}/reassign": "review.assign", "POST /api/v1/review/items/{id}/force-release": "review.assign",
		"POST /api/v1/review/items/{id}/assign": "review.assign", "POST /api/v1/review/import": "review.import",
		"POST /api/v1/review/items/{id}/claim": "review.work", "PUT /api/v1/review/items/{id}/conform": "review.work",
		"POST /api/v1/review/items/{id}/qc": "review.qc.run", "POST /api/v1/review/items/{id}/proxy": "review.work|review.qc.run",
	}
	for pat, feat := range need {
		rt, ok := h.routes[pat]
		if !ok || rt.auth.Kind != module.AuthFeature || strings.Join(rt.auth.Features, "|") != feat {
			t.Errorf("%s: erwartet Funktionsrecht %s, ist %+v", pat, feat, rt.auth)
		}
	}
	if rt := h.routes["PUT /api/v1/review/config"]; rt.auth.Kind != module.AuthVerbGlobal || string(rt.auth.Verb) != "admin" {
		t.Errorf("config: %+v", rt.auth)
	}
	// Jedes deklarierte Funktionsrecht wird auch von einer Route verlangt (keine toten Rechte).
	used := map[string]bool{}
	for _, rt := range h.routes {
		if rt.auth.Kind == module.AuthFeature {
			for _, f := range rt.auth.Features {
				used[f] = true
			}
		}
	}
	for _, f := range (*Module)(nil).Features() {
		if f.ID != FeatView && !used[f.ID] {
			t.Errorf("Funktionsrecht %s wird von keiner Route verlangt", f.ID)
		}
	}
}

func TestHTTPClaimConflictRevisionConflictAndValidation(t *testing.T) {
	h := newHTTPEnv(t)
	it := h.importReady(t)
	base := "/api/v1/review/items/" + it.AssetID

	rec := h.call(t, "POST", base+"/claim", "alice", nil)
	if rec.Code != 200 {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body)
	}
	rev := int64(decode(t, rec)["item"].(map[string]any)["revision"].(float64))
	if rec := h.call(t, "POST", base+"/claim", "bob", nil); rec.Code != 409 || decode(t, rec)["code"] != "claimed" {
		t.Fatalf("second claim: %d %s", rec.Code, rec.Body)
	}
	// ungültiger Bereich → 400 mit Einzelproblemen
	rec = h.call(t, "PUT", base+"/conform", "alice", map[string]any{"expectedRevision": rev, "segments": []map[string]any{{"label": "x", "in": 0, "out": 999}}})
	if rec.Code != 400 || len(decode(t, rec)["problems"].([]any)) == 0 {
		t.Fatalf("invalid range: %d %s", rec.Code, rec.Body)
	}
	// gültig speichern, danach mit alter Revision → 409 + aktueller Stand
	rec = h.call(t, "PUT", base+"/conform", "alice", map[string]any{"expectedRevision": rev, "segments": []map[string]any{{"label": "A", "in": 0, "out": 100}}})
	if rec.Code != 200 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	rec = h.call(t, "PUT", base+"/conform", "alice", map[string]any{"expectedRevision": rev, "segments": []map[string]any{{"label": "B", "in": 0, "out": 50}}})
	if rec.Code != 409 || decode(t, rec)["code"] != "revision_conflict" || decode(t, rec)["current"] == nil {
		t.Fatalf("stale: %d %s", rec.Code, rec.Body)
	}
	// Fremder darf nicht speichern → 403
	cur := decode(t, h.call(t, "GET", base, "alice", nil))["item"].(map[string]any)
	rec = h.call(t, "PUT", base+"/conform", "mallory", map[string]any{"expectedRevision": cur["revision"], "segments": []map[string]any{{"label": "x", "in": 0, "out": 10}}})
	if rec.Code != 403 {
		t.Fatalf("foreign save: %d", rec.Code)
	}
	// Timecode-Endpunkt: Frame 50 = 10:00:02:00 nicht erwartet — Fixture startet bei 10:00:00:00
	rec = h.call(t, "GET", base+"/timecode?frame=50", "alice", nil)
	if rec.Code != 200 || decode(t, rec)["timecode"] != "10:00:02:00" {
		t.Fatalf("timecode: %d %s", rec.Code, rec.Body)
	}
	rec = h.call(t, "GET", base+"/timecode?tc=10:00:04:00", "alice", nil)
	if rec.Code != 200 || decode(t, rec)["frame"].(float64) != 100 {
		t.Fatalf("tc→frame: %d %s", rec.Code, rec.Body)
	}
	if rec := h.call(t, "GET", base+"/timecode?tc=09:00:00:00", "alice", nil); rec.Code != 400 {
		t.Fatalf("tc outside file: %d", rec.Code)
	}
	// Bericht exportieren (JSON + CSV), CSV ohne Formel-Injection
	item := decode(t, h.call(t, "GET", base, "alice", nil))["item"].(map[string]any)
	rid := item["qcReportId"].(string)
	rec = h.call(t, "GET", "/api/v1/review/qc/reports/"+rid+"/export?format=csv", "alice", nil)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/csv") || !strings.Contains(rec.Body.String(), "container.readable") {
		t.Fatalf("csv: %d", rec.Code)
	}
	if csvSafe("=cmd") != "'=cmd" || csvSafe("ok") != "ok" {
		t.Fatal("csvSafe")
	}
	rec = h.call(t, "GET", "/api/v1/review/qc/reports/"+rid+"/export", "alice", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"profile"`) || !strings.Contains(rec.Body.String(), `"tools"`) {
		t.Fatalf("json export lacks provenance: %s", rec.Body)
	}
}

func TestHTTPProxyRangeAndFrame(t *testing.T) {
	h := newHTTPEnv(t)
	it := h.importReady(t)
	base := "/api/v1/review/items/" + it.AssetID
	if rec := h.call(t, "GET", "/api/v1/review/media/"+it.AssetID+"/proxy", "a", nil); rec.Code != 404 {
		t.Fatalf("before proxy exists: %d", rec.Code)
	}
	if rec := h.call(t, "POST", base+"/proxy", "alice", nil); rec.Code != 202 {
		t.Fatalf("request proxy: %d", rec.Code)
	}
	if ran, err := h.svc.RunNextProxy(context.Background()); !ran || err != nil {
		t.Fatal(ran, err)
	}
	path := "/api/v1/review/media/" + it.AssetID + "/proxy"
	req := httptest.NewRequest("GET", path, nil)
	req.SetPathValue("id", it.AssetID)
	req.Header.Set("Range", "bytes=0-99")
	rec := httptest.NewRecorder()
	h.routes["GET /api/v1/review/media/{id}/proxy"].h(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.Len() != 100 || rec.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("range: %d len=%d", rec.Code, rec.Body.Len())
	}
	rec = h.call(t, "GET", "/api/v1/review/media/"+it.AssetID+"/frame/10.jpg", "a", nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/jpeg" || rec.Body.Len() < 500 {
		t.Fatalf("frame: %d", rec.Code)
	}
	if rec := h.call(t, "GET", "/api/v1/review/media/"+it.AssetID+"/frame/9999.jpg", "a", nil); rec.Code != 400 {
		t.Fatalf("frame out of range: %d", rec.Code)
	}
}

func TestHTTPConfigRoundTripAndRejectsInvalid(t *testing.T) {
	h := newHTTPEnv(t)
	rec := h.call(t, "GET", "/api/v1/review/config", "a", nil)
	if rec.Code != 200 || decode(t, rec)["approvalMode"] != "single" {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	cfg := decode(t, rec)
	cfg["approvalMode"] = "dual"
	if rec := h.call(t, "PUT", "/api/v1/review/config", "admin", cfg); rec.Code != 200 || decode(t, rec)["approvalMode"] != "dual" {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	cfg["approvalMode"] = "triple"
	if rec := h.call(t, "PUT", "/api/v1/review/config", "admin", cfg); rec.Code != 400 {
		t.Fatalf("invalid config accepted: %d", rec.Code)
	}
}

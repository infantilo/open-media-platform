package mcr

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
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

type nopAudit struct{ n int }

func (a *nopAudit) Log(actor, objectType, objectID, action string, details map[string]any) { a.n++ }

type env struct {
	t      *testing.T
	routes fakeRoutes
	set    *memSettings
	audit  *nopAudit
	m      *Module
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db := dbtest.Open(t)
	m := New()
	reg := module.NewRegistry()
	if err := reg.Register(m); err != nil {
		t.Fatal(err)
	}
	if err := reg.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, tbl := range []string{"mcr_members", "mcr_lines", "mcr_events", "mcr_templates"} {
		if _, err := db.Exec("DELETE FROM " + tbl); err != nil {
			t.Fatal(err)
		}
	}
	e := &env{t: t, routes: fakeRoutes{}, set: &memSettings{m: map[string][]byte{}}, audit: &nopAudit{}, m: m}
	if err := m.Mount(e.routes, module.Deps{DB: db, Settings: e.set, Audit: e.audit}); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) call(method, pattern, path string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	rt, ok := e.routes[method+" "+pattern]
	if !ok {
		e.t.Fatalf("Route %s %s fehlt", method, pattern)
	}
	var rd *bytes.Reader
	switch b := body.(type) {
	case nil:
		rd = bytes.NewReader(nil)
	case string:
		rd = bytes.NewReader([]byte(b))
	default:
		raw, _ := json.Marshal(b)
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	req = req.WithContext(module.WithUser(req.Context(), "alice"))
	// Pfad-Platzhalter {id}
	if i := strings.Index(pattern, "{id}"); i >= 0 {
		rest := strings.TrimPrefix(path, pattern[:i])
		req.SetPathValue("id", strings.SplitN(rest, "/", 2)[0])
	}
	rec := httptest.NewRecorder()
	rt.h(rec, req)
	return rec
}

func dec(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("keine JSON-Antwort (%d): %s", rec.Code, rec.Body.String())
	}
	return m
}

const house1080 = `{"video":{"width":1920,"height":1080,"rate":"25/1","scan":"interlaced_tff","colorspace":"BT709","transfer":"SDR"},"audio":{"sampleRate":48000,"channels":8}}`

func TestHouseValidationAndInheritance(t *testing.T) {
	for _, bad := range []string{
		`{"video":{"width":0,"height":1080,"rate":"25/1","scan":"progressive"}}`,
		`{"video":{"width":1920,"height":1080,"rate":"0/1","scan":"progressive"}}`,
		`{"video":{"width":1920,"height":1081,"rate":"25/1","scan":"interlaced_tff"}}`,
		`{"video":{"width":1920,"height":1080,"rate":"25/1","scan":"foo"}}`,
		`{"audio":{"sampleRate":100,"channels":2}}`,
		`{"audio":{"sampleRate":48000,"channels":2,"groups":[{"name":"x","channels":[3]}]}}`,
		`{"video":{"width":1,"height":1,"rate":"25/1","scan":"progressive","oops":1}}`,
	} {
		if _, err := ParseHouse(json.RawMessage(bad)); err == nil {
			t.Errorf("sollte abgelehnt werden: %s", bad)
		}
	}
	g, _ := ParseHouse(json.RawMessage(house1080))
	ev, _ := ParseHouse(json.RawMessage(`{"video":{"width":1280,"height":720,"rate":"50/1","scan":"progressive"}}`))
	ln, _ := ParseHouse(json.RawMessage(`{"audio":{"sampleRate":44100,"channels":2}}`))
	eff := Effective(g, ev, ln)
	if eff.Video.Width != 1280 || eff.Audio.SampleRate != 44100 {
		t.Fatalf("Vererbung: %+v %+v", eff.Video, eff.Audio)
	}
	eff2 := Effective(g, ev, nil)
	if eff2.Audio.SampleRate != 48000 || eff2.Video.Rate != "50/1" {
		t.Fatalf("Event überstimmt Vorgabe, Audio bleibt Vorgabe: %+v", eff2)
	}
}

func TestLifecycleGraph(t *testing.T) {
	ok := [][2]string{{"planned", "testing"}, {"testing", "planned"}, {"testing", "live"}, {"live", "teardown"}, {"teardown", "done"}, {"planned", "cancelled"}, {"testing", "cancelled"}}
	for _, p := range ok {
		if !lifecycle.Allowed(p[0], p[1]) {
			t.Errorf("%v sollte erlaubt sein", p)
		}
	}
	for _, p := range [][2]string{{"planned", "live"}, {"done", "testing"}, {"live", "planned"}, {"live", "testing"}, {"done", "planned"}, {"cancelled", "planned"}} {
		if lifecycle.Allowed(p[0], p[1]) {
			t.Errorf("%v darf nicht erlaubt sein", p)
		}
	}
}

func TestSecretsRejected(t *testing.T) {
	for _, tr := range []string{`{"passphrase":"geheim12345"}`, `{"nested":{"Password":"x"}}`, `{"uri":"srt://h:1?passphrase=abc"}`, `{"list":[{"token":"t"}]}`} {
		l := Line{Name: "L", Kind: KindSRT, Transport: json.RawMessage(tr)}
		if err := validateLine(&l); err == nil {
			t.Errorf("Geheimnis nicht abgelehnt: %s", tr)
		}
	}
	l := Line{Name: "L", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://h:1","passphraseKey":"srt-pgm"}`)}
	if err := validateLine(&l); err != nil {
		t.Errorf("Schlüsselname muss erlaubt sein: %v", err)
	}
}

func TestEventFromTemplateAndLifecycleViaAPI(t *testing.T) {
	e := newEnv(t)
	tpl := map[string]any{"name": "Fussball", "houseFormat": json.RawMessage(`{"audio":{"sampleRate":48000,"channels":16}}`), "lines": []Line{
		{Name: "PGM", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9000","mode":"listener"}`)},
		{Name: "CLF", Kind: KindMXL},
	}}
	rec := e.call("POST", "/api/v1/mcr/templates", "/api/v1/mcr/templates", tpl)
	if rec.Code != 201 {
		t.Fatalf("Vorlage: %d %s", rec.Code, rec.Body)
	}
	tid := dec(t, rec)["id"].(string)

	// globales Hausformat setzen
	rec = e.call("PUT", "/api/v1/mcr/settings", "/api/v1/mcr/settings", map[string]any{"houseFormat": json.RawMessage(house1080)})
	if rec.Code != 200 {
		t.Fatalf("Einstellungen: %d %s", rec.Code, rec.Body)
	}

	rec = e.call("POST", "/api/v1/mcr/events", "/api/v1/mcr/events", map[string]any{"name": "A gegen B", "templateId": tid})
	if rec.Code != 201 {
		t.Fatalf("Event: %d %s", rec.Code, rec.Body)
	}
	ev := dec(t, rec)
	id := ev["id"].(string)
	lines := ev["lines"].([]any)
	if len(lines) != 2 || ev["state"] != "planned" {
		t.Fatalf("Leitungen aus Vorlage: %v", ev)
	}
	// wirksames Hausformat: Video aus Vorgabe, Ton aus Vorlage (16 Kanäle)
	eff := ev["effectiveHouse"].(map[string]any)
	first := eff[lines[0].(map[string]any)["id"].(string)].(map[string]any)
	if first["audio"].(map[string]any)["channels"].(float64) != 16 || first["video"].(map[string]any)["width"].(float64) != 1920 {
		t.Fatalf("wirksam: %v", first)
	}

	tr := func(to string) int {
		return e.call("POST", "/api/v1/mcr/events/{id}/transition", "/api/v1/mcr/events/"+id+"/transition", map[string]any{"to": to}).Code
	}
	if c := tr("live"); c != 409 {
		t.Fatalf("planned → live muss 409 sein: %d", c)
	}
	if c := tr("testing"); c != 200 {
		t.Fatalf("planned → testing: %d", c)
	}
	if c := tr("planned"); c != 200 {
		t.Fatalf("testing → planned (Umbau): %d", c)
	}
	if c := tr("testing"); c != 200 {
		t.Fatalf("erneut testing: %d", c)
	}
	// Löschen nur in planned/done/cancelled
	if c := e.call("DELETE", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+id, nil).Code; c != 409 {
		t.Fatalf("Löschen in testing muss 409 sein: %d", c)
	}
	if c := tr("live"); c != 200 {
		t.Fatalf("testing → live: %d", c)
	}
	// in live: Struktur darf sich nicht ändern, Einstellungen schon
	rec = e.call("PUT", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+id, map[string]any{"name": "A gegen B", "lines": []Line{{Name: "NEU", Kind: KindMXL}}})
	if rec.Code != 409 {
		t.Fatalf("Struktur in live: %d %s", rec.Code, rec.Body)
	}
	rec = e.call("PUT", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+id, map[string]any{"name": "A gegen B (live)", "houseFormat": json.RawMessage(`{"video":{"width":1280,"height":720,"rate":"50/1","scan":"progressive"}}`)})
	if rec.Code != 200 {
		t.Fatalf("Einstellung in live: %d %s", rec.Code, rec.Body)
	}
	got := dec(t, rec)
	f := got["effectiveHouse"].(map[string]any)[lines[0].(map[string]any)["id"].(string)].(map[string]any)
	if f["video"].(map[string]any)["width"].(float64) != 1280 {
		t.Fatalf("Event überstimmt Vorgabe nicht: %v", f)
	}
	if c := tr("teardown"); c != 200 {
		t.Fatalf("teardown: %d", c)
	}
	if c := tr("testing"); c != 409 {
		t.Fatalf("teardown → testing: %d", c)
	}
	if c := tr("done"); c != 200 {
		t.Fatalf("done: %d", c)
	}
	if c := tr("testing"); c != 409 {
		t.Fatalf("done → testing muss 409 sein: %d", c)
	}
	if c := e.call("DELETE", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+id, nil).Code; c != 204 {
		t.Fatalf("Löschen in done: %d", c)
	}
	if e.audit.n < 8 {
		t.Fatalf("Domain-Audit zu selten: %d", e.audit.n)
	}
}

func TestValidationErrorsAre400(t *testing.T) {
	e := newEnv(t)
	post := func(body any) *httptest.ResponseRecorder {
		return e.call("POST", "/api/v1/mcr/events", "/api/v1/mcr/events", body)
	}
	if c := post(map[string]any{"name": ""}).Code; c != 400 {
		t.Errorf("leerer Name: %d", c)
	}
	rec := post(map[string]any{"name": "E", "lines": []Line{{Name: "L", Kind: KindSRT, Transport: json.RawMessage(`{"passphrase":"geheim12345"}`)}}})
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "passphrase") {
		t.Errorf("Geheimnis: %d %s", rec.Code, rec.Body)
	}
	if c := post(map[string]any{"name": "E", "houseFormat": json.RawMessage(`{"video":{"width":1920,"height":1080,"rate":"0/1","scan":"progressive"}}`)}).Code; c != 400 {
		t.Errorf("ungültige Rate: %d", c)
	}
	if c := post(map[string]any{"name": "E", "lines": []Line{{Name: "L", Kind: "foo"}}}).Code; c != 400 {
		t.Errorf("unbekannte Art: %d", c)
	}
	if c := post(map[string]any{"name": "E", "lines": []Line{{Name: "L", Kind: KindMXL, Avsync: json.RawMessage(`{"mode":"tracking"}`)}}}).Code; c != 400 {
		t.Errorf("tracking: %d", c)
	}
	if c := post(map[string]any{"name": "E", "members": []Member{{SubjectType: "user", Subject: "bob", Role: "chef"}}}).Code; c != 400 {
		t.Errorf("Rolle: %d", c)
	}
	if c := e.call("GET", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/gibtsnicht", nil).Code; c != 404 {
		t.Errorf("unbekannt: %d", c)
	}
	if c := e.call("PUT", "/api/v1/mcr/settings", "/api/v1/mcr/settings", map[string]any{"houseFormat": json.RawMessage(`{"video":{"width":1,"height":1,"rate":"x","scan":"progressive"}}`)}).Code; c != 400 {
		t.Errorf("Einstellung ungültig: %d", c)
	}
}

func TestMembersAndEventRoles(t *testing.T) {
	e := newEnv(t)
	rec := e.call("POST", "/api/v1/mcr/events", "/api/v1/mcr/events", map[string]any{"name": "E"})
	id := dec(t, rec)["id"].(string)
	rec = e.call("PUT", "/api/v1/mcr/events/{id}/members", "/api/v1/mcr/events/"+id+"/members", map[string]any{"members": []Member{
		{SubjectType: "user", Subject: "bob", Role: RoleLead}, {SubjectType: "group", Subject: "kommentatoren", Role: RoleCommentator}}})
	if rec.Code != 200 || len(dec(t, rec)["members"].([]any)) != 2 {
		t.Fatalf("Mitglieder: %d %s", rec.Code, rec.Body)
	}
	rec = e.call("PUT", "/api/v1/mcr/events/{id}/members", "/api/v1/mcr/events/"+id+"/members", map[string]any{"members": []Member{
		{SubjectType: "user", Subject: "bob", Role: RoleLead}, {SubjectType: "user", Subject: "bob", Role: RoleViewer}}})
	if rec.Code != 400 {
		t.Fatalf("doppelt: %d", rec.Code)
	}
}

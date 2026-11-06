package radio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

func TestValidateContent(t *testing.T) {
	ok := []string{``, `{}`, `{"log":{"items":[]},"carts":[],"cards":[{"id":"c"}],"notes":null,"extra":{"x":1}}`}
	for _, s := range ok {
		if err := ValidateContent(json.RawMessage(s)); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	bad := []string{`[]`, `"x"`, `{"carts":{}}`, `{"log":[]}`, `{"carts":[` + strings.Repeat("1,", 64) + `1]}`}
	for _, s := range bad {
		if err := ValidateContent(json.RawMessage(s)); !errors.Is(err, ErrValidation) {
			t.Errorf("%q sollte abgelehnt werden, war %v", s, err)
		}
	}
	if err := ValidateContent(json.RawMessage(`{"a":"` + strings.Repeat("x", maxContentBytes) + `"}`)); err == nil {
		t.Error("zu großes Dokument muss abgelehnt werden")
	}
}

func TestInputValidate(t *testing.T) {
	now := time.Now()
	later := now.Add(time.Hour)
	cases := []struct {
		name string
		in   Input
		ok   bool
	}{
		{"gut", Input{Title: "Morgenshow", SlotStart: &now, SlotEnd: &later}, true},
		{"ohne Titel", Input{Title: "  "}, false},
		{"Ende vor Beginn", Input{Title: "x", SlotStart: &later, SlotEnd: &now}, false},
		{"Vorlage mit Zeitfenster", Input{Title: "x", Template: true, SlotStart: &now}, false},
		{"Vorlage", Input{Title: "Format", Template: true}, true},
	}
	for _, c := range cases {
		if err := c.in.Validate(); (err == nil) != c.ok {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestTransitions(t *testing.T) {
	if !canTransition(StatusDraft, StatusReady) || canTransition(StatusDraft, StatusLive) || canTransition(StatusDone, StatusLive) || !canTransition(StatusLive, StatusDone) {
		t.Fatal("Übergangstabelle")
	}
	if !needsRelease(StatusLive) || needsRelease(StatusDraft) || needsRelease(StatusArchived) {
		t.Fatal("Freigabe-Recht")
	}
}

func newStore(t *testing.T) (*Store, *Module) {
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
	_, _ = db.Exec("DELETE FROM radio_shows")
	m.d = module.Deps{DB: db}
	return NewStore(db), m
}

func TestStoreLifecycle(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	start := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	end := start.Add(time.Hour)
	content := json.RawMessage(`{"log":{"logId":"x","items":[]},"carts":[{"label":"Jingle","file":"/m/j.wav"}],"cards":[{"id":"c1","text":"Guten Morgen"}]}`)
	s, err := st.Create(ctx, Input{Title: "Morgenshow", SlotStart: &start, SlotEnd: &end, Presenters: []string{" anna ", "anna", "ben"}, Content: content}, "anna")
	if err != nil {
		t.Fatal(err)
	}
	if s.Status != StatusDraft || s.RowVersion != 1 || len(s.Presenters) != 2 || s.Owner != "anna" {
		t.Fatalf("angelegt: %+v", s)
	}
	// Ändern mit falschem Stand → Konflikt
	if _, err := st.Update(ctx, s.ID, Input{Title: "Morgenshow 2", RowVersion: 7}, "ben"); !errors.Is(err, ErrConflict) {
		t.Fatalf("erwartet Konflikt, war %v", err)
	}
	s2, err := st.Update(ctx, s.ID, Input{Title: "Morgenshow 2", SlotStart: &start, SlotEnd: &end, Content: json.RawMessage(`{"cards":[]}`), RowVersion: 1, Reason: "Karten geleert"}, "ben")
	if err != nil || s2.RowVersion != 2 || s2.UpdatedBy != "ben" {
		t.Fatalf("update: %+v %v", s2, err)
	}
	vs, err := st.Versions(ctx, s.ID)
	if err != nil || len(vs) != 2 || vs[0].Version != 2 || vs[0].Reason != "Karten geleert" {
		t.Fatalf("Versionen: %+v %v", vs, err)
	}
	v1, err := st.GetVersion(ctx, s.ID, 1)
	if err != nil || !bytes.Contains(v1.Content, []byte("Guten Morgen")) {
		t.Fatalf("Version 1: %v %s", err, v1.Content)
	}
	// Statuskette
	if _, err := st.SetStatus(ctx, s.ID, StatusLive, "x"); !errors.Is(err, ErrState) {
		t.Fatalf("draft → live muss scheitern: %v", err)
	}
	for _, to := range []string{StatusReady, StatusLive} {
		if _, err := st.SetStatus(ctx, s.ID, to, "x"); err != nil {
			t.Fatalf("→ %s: %v", to, err)
		}
	}
	if _, err := st.Update(ctx, s.ID, Input{Title: "x", RowVersion: 2}, "ben"); !errors.Is(err, ErrState) {
		t.Fatalf("laufende Sendung darf nicht geändert werden: %v", err)
	}
	if err := st.Delete(ctx, s.ID); !errors.Is(err, ErrState) {
		t.Fatalf("laufende Sendung darf nicht gelöscht werden: %v", err)
	}
	if _, err := st.SetStatus(ctx, s.ID, StatusDone, "x"); err != nil {
		t.Fatal(err)
	}
	if err := st.Delete(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Get(ctx, s.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("gelöscht: %v", err)
	}
}

func TestListFilterTemplateDuplicate(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	t0 := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	t1 := t0.Add(time.Hour)
	tpl, err := st.Create(ctx, Input{Title: "Format Morgenshow", Template: true, Content: json.RawMessage(`{"carts":[{"label":"A"}]}`)}, "anna")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetStatus(ctx, tpl.ID, StatusReady, "x"); !errors.Is(err, ErrState) {
		t.Fatalf("Vorlage hat keinen Sendestatus: %v", err)
	}
	a, err := st.Duplicate(ctx, tpl.ID, Input{Title: "Morgenshow 12.11.", SlotStart: &t0, SlotEnd: &t1, Presenters: []string{"ben"}}, "ben")
	if err != nil || a.Template || !bytes.Contains(a.Content, []byte(`"A"`)) || a.Presenters[0] != "ben" {
		t.Fatalf("aus Vorlage: %+v %v", a, err)
	}
	yes, no := true, false
	if l, _ := st.List(ctx, Filter{Template: &yes}); len(l) != 1 || l[0].ID != tpl.ID || len(l[0].Content) != 0 {
		t.Fatalf("Vorlagen: %+v", l)
	}
	if l, _ := st.List(ctx, Filter{Template: &no}); len(l) != 1 || l[0].ID != a.ID {
		t.Fatalf("Sendungen: %+v", l)
	}
	if l, _ := st.List(ctx, Filter{User: "ben"}); len(l) != 1 {
		t.Fatalf("meine (Moderation): %+v", l)
	}
	if l, _ := st.List(ctx, Filter{User: "anna"}); len(l) != 1 || l[0].ID != tpl.ID {
		t.Fatalf("meine (Besitz): %+v", l)
	}
	from, to := t0.Add(2*time.Hour), t0.Add(3*time.Hour)
	if l, _ := st.List(ctx, Filter{Template: &no, From: &from, To: &to}); len(l) != 0 {
		t.Fatalf("Zeitfenster ohne Treffer: %+v", l)
	}
	// Versionsbegrenzung
	for i := 0; i < keepVersions+5; i++ {
		cur, _ := st.Get(ctx, a.ID)
		if _, err := st.Update(ctx, a.ID, Input{Title: "x", SlotStart: &t0, SlotEnd: &t1, RowVersion: cur.RowVersion}, "ben"); err != nil {
			t.Fatal(err)
		}
	}
	if vs, _ := st.Versions(ctx, a.ID); len(vs) != keepVersions {
		t.Fatalf("Versionen begrenzt auf %d, sind %d", keepVersions, len(vs))
	}
}

// ---- HTTP mit Rechten ----

type fakeAccess struct {
	user string
	has  map[string]bool
}

func (f fakeAccess) Can(r *http.Request, feature string) bool { return f.has[feature] }
func (f fakeAccess) Identity(r *http.Request) module.Identity {
	return module.Identity{User: f.user, Has: func(s string) bool { return f.has[s] }}
}

func do(t *testing.T, h http.Handler, method, path string, body any, user string) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req = req.WithContext(module.WithUser(req.Context(), user))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type muxRoutes struct{ mux *http.ServeMux }

func (m muxRoutes) Handle(p string, _ module.Auth, h http.HandlerFunc) { m.mux.HandleFunc(p, h) }

func TestHTTPOwnershipAndRelease(t *testing.T) {
	st, m := newStore(t)
	_ = st
	mux := http.NewServeMux()
	// Rechte: Anna darf vorbereiten, Ben darf freigeben, Clara hat nichts
	acc := map[string]fakeAccess{
		"anna":  {"anna", map[string]bool{FeatPrepare: true}},
		"ben":   {"ben", map[string]bool{FeatPrepare: true, FeatRelease: true}},
		"clara": {"clara", map[string]bool{FeatPrepare: true}},
	}
	cur := "anna"
	a := &api{m: m, access: dyn{&cur, acc}}
	mux.HandleFunc("POST /s", a.create())
	mux.HandleFunc("PUT /s/{id}", a.update())
	mux.HandleFunc("POST /s/{id}/status", a.setStatus())
	mux.HandleFunc("DELETE /s/{id}", a.delete())
	mux.HandleFunc("GET /s/{id}/versions/{version}", a.version())
	mux.HandleFunc("POST /s/{id}/versions/{version}/restore", a.restore())

	as := func(u string) { cur = u }
	rec := do(t, mux, "POST", "/s", Input{Title: "Show", Presenters: []string{"clara"}, Content: json.RawMessage(`{"cards":[{"id":"1"}]}`)}, "anna")
	if rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var sh Show
	_ = json.Unmarshal(rec.Body.Bytes(), &sh)
	// Moderierende (Clara) darf bearbeiten, ein Fremder (Ben ohne manage_all) nicht
	as("ben")
	if rec := do(t, mux, "PUT", "/s/"+sh.ID, Input{Title: "Fremd", RowVersion: 1}, "ben"); rec.Code != 403 {
		t.Fatalf("Fremder darf nicht ändern: %d", rec.Code)
	}
	as("clara")
	if rec := do(t, mux, "PUT", "/s/"+sh.ID, Input{Title: "Show v2", Presenters: []string{"clara"}, RowVersion: 1, Content: json.RawMessage(`{"cards":[]}`)}, "clara"); rec.Code != 200 {
		t.Fatalf("Moderierende ändert: %d %s", rec.Code, rec.Body)
	}
	// Freigabe: Clara darf nicht, Ben darf
	if rec := do(t, mux, "POST", "/s/"+sh.ID+"/status", map[string]string{"status": "ready"}, "clara"); rec.Code != 403 {
		t.Fatalf("Freigabe ohne Recht: %d", rec.Code)
	}
	as("ben")
	if rec := do(t, mux, "POST", "/s/"+sh.ID+"/status", map[string]string{"status": "ready"}, "ben"); rec.Code != 200 {
		t.Fatalf("Freigabe: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, mux, "POST", "/s/"+sh.ID+"/status", map[string]string{"status": "done"}, "ben"); rec.Code != 409 {
		t.Fatalf("ungültiger Wechsel: %d", rec.Code)
	}
	// Konflikt 409 bei veraltetem Stand
	as("clara")
	if rec := do(t, mux, "PUT", "/s/"+sh.ID, Input{Title: "alt", RowVersion: 1}, "clara"); rec.Code != 409 {
		t.Fatalf("Konflikt: %d %s", rec.Code, rec.Body)
	}
	// Wiederherstellen von Version 1 (Karte war noch da)
	if rec := do(t, mux, "POST", "/s/"+sh.ID+"/versions/1/restore", nil, "clara"); rec.Code != 200 {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, mux, "GET", "/s/"+sh.ID+"/versions/abc", nil, "clara"); rec.Code != 400 {
		t.Fatalf("version abc: %d", rec.Code)
	}
}

type dyn struct {
	cur *string
	m   map[string]fakeAccess
}

func (d dyn) Can(r *http.Request, f string) bool       { return d.m[*d.cur].Can(r, f) }
func (d dyn) Identity(r *http.Request) module.Identity { return d.m[*d.cur].Identity(r) }

package mcr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type testPerson struct {
	groups   []string
	features []string
}

// fakeAccess: Rechtespeicher für Tests mit Testnutzern (nie echte Konten).
type fakeAccess map[string]testPerson

func (f fakeAccess) Can(r *http.Request, feature string) bool { return f.Identity(r).Has(feature) }
func (f fakeAccess) Identity(r *http.Request) module.Identity {
	u := module.Actor(r)
	p := f[u]
	return module.Identity{User: u, Groups: p.groups, Has: func(ft string) bool {
		for _, x := range p.features {
			if x == ft {
				return true
			}
		}
		return false
	}}
}

func accessEnv(t *testing.T, acc fakeAccess) (*env, *Service) {
	t.Helper()
	db := dbtest.Open(t)
	m := New()
	reg := module.NewRegistry()
	if err := reg.Register(m); err != nil {
		t.Fatal(err)
	}
	if err := reg.Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"mcr_members", "mcr_lines", "mcr_events", "mcr_templates", "mcr_bindings"} {
		if _, err := db.Exec("DELETE FROM " + tbl); err != nil {
			t.Fatal(err)
		}
	}
	e := &env{t: t, routes: fakeRoutes{}, set: &memSettings{m: map[string][]byte{}}, audit: &nopAudit{}, m: m}
	if err := m.Mount(e.routes, module.Deps{DB: db, Settings: e.set, Audit: e.audit, Access: acc}); err != nil {
		t.Fatal(err)
	}
	return e, m.svc
}

// as ruft eine Route als Testnutzer auf.
func (e *env) as(user, method, pattern, path string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	rt, ok := e.routes[method+" "+pattern]
	if !ok {
		e.t.Fatalf("Route %s %s fehlt", method, pattern)
	}
	var rd *strings.Reader
	switch b := body.(type) {
	case nil:
		rd = strings.NewReader("")
	case string:
		rd = strings.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		rd = strings.NewReader(string(raw))
	}
	req := httptest.NewRequest(method, path, rd)
	req = req.WithContext(module.WithUser(req.Context(), user))
	if i := strings.Index(pattern, "{id}"); i >= 0 {
		rest := strings.TrimPrefix(path, pattern[:i])
		req.SetPathValue("id", strings.SplitN(rest, "/", 2)[0])
		if j := strings.Index(pattern, "{lineId}"); j >= 0 {
			parts := strings.Split(strings.TrimPrefix(path, pattern[:i]), "/")
			if len(parts) >= 3 {
				req.SetPathValue("lineId", parts[2])
			}
		}
	}
	rec := httptest.NewRecorder()
	rt.h(rec, req)
	return rec
}

func TestAllowedMatrix(t *testing.T) {
	ev := Event{Owner: "owner1", OwnerGroup: "gruppe-o", Members: []Member{
		{SubjectType: "user", Subject: "lena", Role: RoleLead}, {SubjectType: "user", Subject: "tom", Role: RoleEngineer},
		{SubjectType: "user", Subject: "vera", Role: RoleViewer}, {SubjectType: "user", Subject: "kai", Role: RoleCommentator},
		{SubjectType: "group", Subject: "technik", Role: RoleEngineer},
	}}
	type c struct {
		who  Actor
		act  string
		want bool
	}
	cases := []c{
		{Actor{User: "lena"}, ActLive, true}, {Actor{User: "lena"}, ActEdit, true}, {Actor{User: "lena"}, ActMembers, false},
		{Actor{User: "tom"}, ActTest, true}, {Actor{User: "tom"}, ActLive, false}, {Actor{User: "tom"}, ActEdit, false},
		{Actor{User: "vera"}, ActView, true}, {Actor{User: "vera"}, ActTest, false},
		{Actor{User: "kai"}, ActView, false},                            // Kommentator hat keinen Zugriff in der Verwaltung
		{Actor{User: "x", Groups: []string{"technik"}}, ActTest, true},  // Gruppenmitglied
		{Actor{User: "x", Groups: []string{"gruppe-o"}}, ActLive, true}, // Verantwortliche Gruppe = lead
		{Actor{User: "owner1"}, ActEdit, true},
		{Actor{User: "fremd"}, ActView, false},
		{Actor{User: "fremd", View: true}, ActView, true}, {Actor{User: "fremd", View: true}, ActTest, false},
		{Actor{User: "hkr", Live: true, View: true}, ActLive, true}, {Actor{User: "hkr", Live: true, View: true}, ActEdit, false},
		{Actor{User: "adm", Manage: true}, ActMembers, true},
		{Actor{Open: true}, ActMembers, true},
	}
	for i, c := range cases {
		if got := Allowed(c.who, ev, c.act); got != c.want {
			t.Errorf("Fall %d (%s %s): %v, erwartet %v", i, c.who.User, c.act, got, c.want)
		}
	}
	if TransitionAction(StatePlanned, StateTesting) != ActTest || TransitionAction(StateTesting, StateLive) != ActLive {
		t.Fatal("Test ↔ Geplant bedient die Technik, alles andere die Leitung")
	}
}

func TestEventRolesOverHTTP(t *testing.T) {
	acc := fakeAccess{
		"admin": {features: []string{FeatManage}},
		"lena":  {}, "tom": {}, "vera": {}, "kai": {}, "fremd": {},
		"hkr": {features: []string{FeatLive}},
	}
	e, svc := accessEnv(t, acc)
	ctx := context.Background()
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Rollen", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}}, Members: []Member{
		{SubjectType: "user", Subject: "lena", Role: RoleLead}, {SubjectType: "user", Subject: "tom", Role: RoleEngineer},
		{SubjectType: "user", Subject: "vera", Role: RoleViewer}, {SubjectType: "user", Subject: "kai", Role: RoleCommentator}}}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	line := ev.Lines[0].ID
	avsync := `{"mode":"manual","manualMs":20}`
	path := "/api/v1/mcr/events/" + ev.ID + "/lines/" + line + "/avsync"
	put := func(user string) int {
		return e.as(user, "PUT", "/api/v1/mcr/events/{id}/lines/{lineId}/avsync", path, avsync).Code
	}
	// Viewer setzt Versatz → 403; Engineer darf; fremdes Event unsichtbar (404)
	if c := put("vera"); c != http.StatusForbidden {
		t.Fatalf("viewer: %d", c)
	}
	if c := put("tom"); c != http.StatusOK {
		t.Fatalf("engineer: %d", c)
	}
	if c := put("fremd"); c != http.StatusNotFound {
		t.Fatalf("fremdes Event: %d", c)
	}
	if c := put("kai"); c != http.StatusNotFound {
		t.Fatalf("Kommentator sieht das Event in der Verwaltung nicht: %d", c)
	}
	// Ansehen
	get := func(user string) int {
		return e.as(user, "GET", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+ev.ID, nil).Code
	}
	if get("vera") != 200 || get("lena") != 200 || get("fremd") != 404 || get("hkr") != 200 {
		t.Fatalf("Sichtbarkeit: vera %d lena %d fremd %d hkr %d", get("vera"), get("lena"), get("fremd"), get("hkr"))
	}
	// Eventliste zeigt nur eigene
	list := func(user string) int {
		rec := e.as(user, "GET", "/api/v1/mcr/events", "/api/v1/mcr/events", nil)
		return len(dec(t, rec)["events"].([]any))
	}
	if list("fremd") != 0 || list("vera") != 1 || list("hkr") != 1 || list("admin") != 1 {
		t.Fatalf("Liste: fremd %d vera %d hkr %d admin %d", list("fremd"), list("vera"), list("hkr"), list("admin"))
	}
	// Rechte am Event in der Antwort
	body := dec(t, e.as("tom", "GET", "/api/v1/mcr/events/{id}", "/api/v1/mcr/events/"+ev.ID, nil))
	acc2 := body["access"].(map[string]any)
	if acc2["role"] != "engineer" || acc2["test"] != true || acc2["live"] != false || acc2["edit"] != false {
		t.Fatalf("access: %+v", acc2)
	}
	// Zustandswechsel: Engineer testet (Geplant → Test), Sendung nur Leitung; Viewer nie
	trans := func(user, to string) int {
		return e.as(user, "POST", "/api/v1/mcr/events/{id}/transition", "/api/v1/mcr/events/"+ev.ID+"/transition", map[string]any{"to": to, "confirm": true}).Code
	}
	if c := trans("vera", StateTesting); c != http.StatusForbidden {
		t.Fatalf("viewer testet: %d", c)
	}
	if c := trans("fremd", StateTesting); c != http.StatusNotFound {
		t.Fatalf("fremd testet: %d", c)
	}
	if c := trans("tom", StateTesting); c != http.StatusOK {
		t.Fatalf("engineer testet: %d", c)
	}
	if c := trans("tom", StateLive); c != http.StatusForbidden {
		t.Fatalf("engineer geht auf Sendung: %d", c)
	}
	if c := trans("lena", StateLive); c != http.StatusOK {
		t.Fatalf("lead geht auf Sendung: %d", c)
	}
	// Mitglieder trägt nur die Verwaltung ein
	members := map[string]any{"members": []Member{{SubjectType: "user", Subject: "x", Role: RoleViewer}}}
	if c := e.as("lena", "PUT", "/api/v1/mcr/events/{id}/members", "/api/v1/mcr/events/"+ev.ID+"/members", members).Code; c != http.StatusForbidden {
		t.Fatalf("lead trägt Mitglieder ein: %d", c)
	}
	if c := e.as("admin", "PUT", "/api/v1/mcr/events/{id}/members", "/api/v1/mcr/events/"+ev.ID+"/members", members).Code; c != http.StatusOK {
		t.Fatalf("Verwaltung trägt Mitglieder ein: %d", c)
	}
	// Alarmhistorie: fremde Person sieht keine Alarme des Events
	_, _, _ = svc.St.RaiseAlarm(ctx, Alarm{EventID: ev.ID, LineID: line, LineName: "A", Kind: "signal-black", Severity: "critical"})
	hist := func(user string) int {
		return len(dec(t, e.as(user, "GET", "/api/v1/mcr/alarms/history", "/api/v1/mcr/alarms/history?days=1", nil))["alarms"].([]any))
	}
	if hist("fremd") != 0 {
		t.Fatalf("Historie für Fremde: %d", hist("fremd"))
	}
}

func TestDesiredBindings(t *testing.T) {
	ev := Event{Owner: "owner1", OwnerGroup: "g1", Members: []Member{
		{SubjectType: "user", Subject: "lena", Role: RoleLead}, {SubjectType: "user", Subject: "tom", Role: RoleEngineer},
		{SubjectType: "user", Subject: "vera", Role: RoleViewer}, {SubjectType: "user", Subject: "kai", Role: RoleCommentator},
		{SubjectType: "user", Subject: "vera", Role: RoleEngineer}, // stärkere gewinnt
	}}
	got := map[string]string{}
	for _, w := range DesiredBindings(ev) {
		got[w.SubjectType+":"+w.Subject] = w.Verb
	}
	want := map[string]string{"user:owner1": "operate", "group:g1": "operate", "user:lena": "operate", "user:tom": "operate", "user:vera": "operate"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: %q, erwartet %q (%v)", k, got[k], v, got)
		}
	}
	if _, ok := got["user:kai"]; ok {
		t.Fatal("Kommentator bekommt keine Workflow-Bindung")
	}
}

type fakeBinder struct {
	mu    sync.Mutex
	n     int
	live  map[string]string // id → "typ:subjekt:verb:workflow"
	fails bool
}

func (f *fakeBinder) add(typ, s, wf, verb string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	id := "b" + itoa(f.n)
	if f.live == nil {
		f.live = map[string]string{}
	}
	f.live[id] = typ + ":" + s + ":" + verb + ":" + wf
	return id, nil
}
func (f *fakeBinder) BindUser(u, wf, v string) (string, error)  { return f.add("user", u, wf, v) }
func (f *fakeBinder) BindGroup(g, wf, v string) (string, error) { return f.add("group", g, wf, v) }
func (f *fakeBinder) Unbind(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.live, id)
	return nil
}

func TestBindingsFollowMembersAndEndWithEvent(t *testing.T) {
	en := newEnv(t)
	svc := en.m.svc
	wf, nodes, fb := newFakeWf(), &fakeNodes{}, &fakeBinder{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Monitor: &fakeMon{}, Binder: fb, Poll: 1, Timeout: 1_000_000_000}
	svc.Run, en.m.rt = rt, rt
	ctx := context.Background()
	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Bind", Lines: []Line{{Name: "A", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`)}},
		Members: []Member{{SubjectType: "user", Subject: "tom", Role: RoleEngineer}, {SubjectType: "group", Subject: "technik", Role: RoleViewer}, {SubjectType: "user", Subject: "kai", Role: RoleCommentator}}}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if ev, err = svc.Transition(ctx, ev.ID, StateTesting, "admin", false); err != nil {
		t.Fatal(err)
	}
	rec := func() {
		full, _ := svc.St.GetEvent(ctx, ev.ID)
		_, _ = rt.Reconcile(ctx, svc, full)
	}
	rec()
	rec()                  // nicht doppelt
	if len(fb.live) != 3 { // Verantwortlicher (Ersteller) gilt als lead, dazu tom und die Gruppe; keine für den Kommentator
		t.Fatalf("drei Bindungen (admin/tom operate, Gruppe view), keine für den Kommentator: %v", fb.live)
	}
	// Mitglied entfernt, anderes zugefügt → nur die Änderung
	if _, err := svc.SetMembers(ctx, ev.ID, []Member{{SubjectType: "user", Subject: "tom", Role: RoleEngineer}, {SubjectType: "user", Subject: "neu", Role: RoleLead}}, "admin"); err != nil {
		t.Fatal(err)
	}
	rec()
	got := strings.Join(sortedValues(fb.live), " ")
	if !strings.Contains(got, "user:neu:operate") || strings.Contains(got, "group:technik") || !strings.Contains(got, "user:tom:operate") {
		t.Fatalf("Bindungen folgen den Mitgliedern: %s", got)
	}
	// Abbau: alle weg
	if _, err := svc.Transition(ctx, ev.ID, StatePlanned, "admin", false); err != nil {
		t.Fatal(err)
	}
	if len(fb.live) != 0 {
		t.Fatalf("nach der Rücknahme keine Bindung mehr: %v", fb.live)
	}
	if left, _ := svc.St.EventBindings(ctx, ev.ID); len(left) != 0 {
		t.Fatalf("auch gemerkte Bindungen weg: %v", left)
	}
}

func sortedValues(m map[string]string) []string {
	var out []string
	for _, v := range m {
		out = append(out, v)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

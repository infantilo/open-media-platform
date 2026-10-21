package intercom

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func sample() Config {
	return Config{
		Channels: []Channel{{ID: 1, Name: "Regie"}, {ID: 2, Name: "Technik"}, {ID: 3, Name: "IFB Moderator", Kind: "ifb", DuckDB: 20}},
		Parties: []Party{
			{ID: 1, Name: "Regie 1", Force: true, Users: []string{"anna"}, Routes: []Route{{Ch: 1, Talk: true, Listen: true}, {Ch: 2, Talk: true, Listen: true}}},
			{ID: 2, Name: "Kamera 1", OnAirLock: true, Groups: []string{"g-kamera"}, Routes: []Route{{Ch: 1, Talk: true, Listen: true}}},
			{ID: 3, Name: "Platz A", Kind: "seat", Open: true, Routes: []Route{{Ch: 2, Listen: true}}},
			{ID: 4, Name: "Programm", Kind: "program", Routes: []Route{{Ch: 3, Talk: true}}},
		},
	}
}

func TestValidateAcceptsSampleAndCollectsAllProblems(t *testing.T) {
	if err := sample().Validate(); err != nil {
		t.Fatal(err)
	}
	bad := Config{
		Channels: []Channel{{ID: 1, Name: "A"}, {ID: 1, Name: "a"}, {ID: 0, Name: ""}, {ID: 5, Name: "X", Kind: "wat"}},
		Parties: []Party{
			{ID: 1, Name: "P", Routes: []Route{{Ch: 9}, {Ch: 1, Pan: 2}, {Ch: 1}}},
			{ID: 1, Name: "p"},
			{ID: GuestBase, Name: "zu groß"},
		},
	}
	err := bad.Validate()
	var ve *ValidationError
	if err == nil {
		t.Fatal("Fehler erwartet")
	}
	ve = err.(*ValidationError)
	joined := strings.Join(ve.Problems, "|")
	for _, want := range []string{"doppelt", "unbekannten Kanal 9", "Lage", "ungültig", "ohne Namen", "Art"} {
		if !strings.Contains(joined, want) {
			t.Errorf("Problem %q fehlt in %q", want, joined)
		}
	}
	if len(ve.Problems) < 8 {
		t.Errorf("alle Probleme auf einmal erwartet, nur %d", len(ve.Problems))
	}
}

func TestMxlPortsValidatedAndPassedToNode(t *testing.T) {
	c := sample()
	c.Parties[3].MxlIn = 1
	c.Parties = append(c.Parties, Party{ID: 5, Name: "Studiolautsprecher", Kind: "port", MxlOut: 2, Routes: []Route{{Ch: 1, Listen: true}}})
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(c.WithTokens(Config{}).NodeConfig(time.Now()))
	if !strings.Contains(string(doc), `"mxl_in":1`) || !strings.Contains(string(doc), `"mxl_out":2`) {
		t.Fatalf("Anschlüsse fehlen: %s", doc)
	}
	bad := sample()
	bad.Parties[3].MxlIn = 1
	bad.Parties = append(bad.Parties, Party{ID: 5, Name: "Zweiter", Kind: "program", MxlIn: 1, Routes: []Route{}}, Party{ID: 6, Name: "Mensch", MxlOut: 1, Routes: []Route{}}, Party{ID: 7, Name: "Zuviel", Kind: "port", MxlIn: 99})
	err := bad.Validate()
	if err == nil {
		t.Fatal("Fehler erwartet")
	}
	joined := strings.Join(err.(*ValidationError).Problems, "|")
	for _, want := range []string{"doppelt belegt", "nur bei Art", "außerhalb 0…16"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q fehlt in %q", want, joined)
		}
	}
}

func TestTokensAreServerSideAndStable(t *testing.T) {
	c1 := sample().WithTokens(Config{})
	for _, p := range c1.Parties {
		if len(p.Token) != 48 {
			t.Fatalf("Token für %s fehlt", p.Name)
		}
	}
	in := sample()
	in.Parties[0].Token = "client-wunsch"
	c2 := in.WithTokens(c1)
	if c2.Parties[0].Token != c1.Parties[0].Token {
		t.Fatal("Client darf Token nicht setzen; bestehender bleibt")
	}
	r := c2.Redacted()
	for _, p := range r.Parties {
		if p.Token != "" {
			t.Fatal("Token dürfen nicht ausgeliefert werden")
		}
	}
	if c2.Parties[0].Token == "" {
		t.Fatal("Redacted darf das Original nicht verändern")
	}
}

func TestNodeConfigMapsKindsGuestsAndExpiry(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	c := sample().WithTokens(Config{})
	c.Guests = []Guest{
		{ID: GuestBase, Name: "Gast", Token: "g1", Expires: now.Add(time.Hour), Routes: []Route{{Ch: 1, Listen: true}}},
		{ID: GuestBase + 1, Name: "abgelaufen", Token: "g2", Expires: now.Add(-time.Minute)},
	}
	doc := c.NodeConfig(now)
	b, _ := json.Marshal(doc)
	var back struct {
		Channels []map[string]any `json:"channels"`
		Parties  []map[string]any `json:"parties"`
	}
	_ = json.Unmarshal(b, &back)
	if len(back.Parties) != 5 {
		t.Fatalf("4 Teilnehmer + 1 aktiver Gast, bekam %d", len(back.Parties))
	}
	kinds := map[string]string{}
	for _, p := range back.Parties {
		kinds[p["name"].(string)] = p["kind"].(string)
	}
	if kinds["Platz A"] != "human" || kinds["Programm"] != "program" || kinds["Gast"] != "human" {
		t.Fatalf("Arten: %v", kinds)
	}
	if _, ok := kinds["abgelaufen"]; ok {
		t.Fatal("abgelaufener Gast darf nicht mehr zum Node")
	}
	if back.Channels[2]["kind"] != "ifb" || back.Channels[2]["duck_db"].(float64) != 20 {
		t.Fatalf("IFB-Kanal: %v", back.Channels[2])
	}
}

func TestPartiesForUserGroupAndOpenSeat(t *testing.T) {
	c := sample()
	names := func(ps []Party) string {
		var s []string
		for _, p := range ps {
			s = append(s, p.Name)
		}
		return strings.Join(s, ",")
	}
	if got := names(c.PartiesFor("Anna", nil)); got != "Regie 1,Platz A" {
		t.Errorf("anna: %s", got)
	}
	if got := names(c.PartiesFor("bob", []string{"g-kamera"})); got != "Kamera 1,Platz A" {
		t.Errorf("bob: %s", got)
	}
	if got := names(c.PartiesFor("carl", nil)); got != "Platz A" {
		t.Errorf("carl: %s", got)
	}
}

type memSettings struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (s *memSettings) Get(k string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.m[k]
	if !ok {
		return nil, module.ErrNotFound
	}
	return b, nil
}
func (s *memSettings) Put(k string, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = b
	return nil
}

type nodes []registry.NodeView

func (n nodes) List() []registry.NodeView { return n }

type insts []launcher.Instance

func (i insts) List() []launcher.Instance { return i }

type fakeNode struct {
	*httptest.Server
	mu   sync.Mutex
	puts []string
}

func newFakeNode(t *testing.T, https bool) *fakeNode {
	f := &fakeNode{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/config":
			b, _ := io.ReadAll(r.Body)
			f.mu.Lock()
			f.puts = append(f.puts, string(b))
			f.mu.Unlock()
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/https-info":
			if https {
				_, _ = w.Write([]byte(`{"enabled":true,"port":9445}`))
			} else {
				_, _ = w.Write([]byte(`{"enabled":false}`))
			}
		case r.URL.Path == "/status":
			_, _ = w.Write([]byte(`{"ticks":5}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func testService(t *testing.T, n *fakeNode) *Service {
	t.Helper()
	nv := registry.NodeView{ID: "n1", Label: "Intercom", Online: true, APIBaseURL: n.URL, InstanceID: "i1"}
	m := New(Services{Nodes: nodes{nv}, Instances: insts{{ID: "i1", Type: "omp-intercom"}}, HTTP: n.Client(), Now: func() time.Time { return time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC) }})
	return m.service(module.Deps{Settings: &memSettings{m: map[string][]byte{}}})
}

func TestUpdatePersistsKeepsTokensAndPushesToNode(t *testing.T) {
	node := newFakeNode(t, false)
	s := testService(t, node)
	c, err := s.Update(context.Background(), "admin", sample())
	if err != nil {
		t.Fatal(err)
	}
	tok := c.Parties[0].Token
	c2, err := s.Update(context.Background(), "admin", sample())
	if err != nil || c2.Parties[0].Token != tok {
		t.Fatalf("Token müssen bei erneutem Speichern bleiben: %v", err)
	}
	s.Push(context.Background())
	node.mu.Lock()
	defer node.mu.Unlock()
	if len(node.puts) == 0 {
		t.Fatal("Node hat keine Konfiguration bekommen")
	}
	if !strings.Contains(node.puts[len(node.puts)-1], tok) {
		t.Fatal("Node bekommt die Token")
	}
}

func TestInvalidUpdateIsRejectedAndKeepsOldConfig(t *testing.T) {
	node := newFakeNode(t, false)
	s := testService(t, node)
	if _, err := s.Update(context.Background(), "a", sample()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(context.Background(), "a", Config{Channels: []Channel{{ID: 1}}}); err == nil {
		t.Fatal("Fehler erwartet")
	}
	c, _ := s.load()
	if len(c.Parties) != 4 {
		t.Fatal("alte Konfiguration muss bleiben")
	}
}

func TestGuestLifecycleAndExpiryPruning(t *testing.T) {
	node := newFakeNode(t, false)
	s := testService(t, node)
	if _, err := s.Update(context.Background(), "a", sample()); err != nil {
		t.Fatal(err)
	}
	g, err := s.CreateGuest(context.Background(), "a", "Interview", []Route{{Ch: 1, Listen: true, Talk: true}}, 30*time.Minute)
	if err != nil || g.ID != GuestBase || g.Token == "" {
		t.Fatalf("Gast: %+v %v", g, err)
	}
	if _, err := s.CreateGuest(context.Background(), "a", "", nil, time.Hour); err == nil {
		t.Fatal("Name Pflicht")
	}
	if _, err := s.CreateGuest(context.Background(), "a", "x", nil, 30*24*time.Hour); err == nil {
		t.Fatal("zu lange Gültigkeit")
	}
	if _, err := s.CreateGuest(context.Background(), "a", "x", []Route{{Ch: 77}}, time.Hour); err == nil {
		t.Fatal("unbekannter Kanal")
	}
	g2, _ := s.CreateGuest(context.Background(), "a", "Zweiter", nil, time.Hour)
	if g2.ID != GuestBase+1 {
		t.Fatalf("fortlaufende IDs, bekam %d", g2.ID)
	}
	// Update der Konfiguration darf Gäste nicht löschen.
	if _, err := s.Update(context.Background(), "a", sample()); err != nil {
		t.Fatal(err)
	}
	c, _ := s.load()
	if len(c.Guests) != 2 {
		t.Fatalf("Gäste müssen bleiben, bekam %d", len(c.Guests))
	}
	if err := s.DeleteGuest(context.Background(), "a", g.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteGuest(context.Background(), "a", g.ID); err != errNotFound {
		t.Fatal("zweites Löschen: nicht gefunden")
	}
}

func TestPanelURLUsesHTTPSPortAndRequestHostForLoopback(t *testing.T) {
	node := newFakeNode(t, true)
	s := testService(t, node)
	u, err := s.PanelURL(context.Background(), "regie.example:8000", "tok123")
	if err != nil {
		t.Fatal(err)
	}
	if u != "https://regie.example:9445/panel?token=tok123" {
		t.Fatalf("URL: %s", u)
	}
	plain := newFakeNode(t, false)
	s2 := testService(t, plain)
	u2, _ := s2.PanelURL(context.Background(), "regie.example", "t")
	if !strings.HasPrefix(u2, "http://regie.example:") || !strings.HasSuffix(u2, "/panel?token=t") {
		t.Fatalf("URL ohne HTTPS: %s", u2)
	}
}

func TestMetricsFromNodeStatus(t *testing.T) {
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"parties":[{"online":true,"underruns":3},{"online":false,"underruns":2}],"late_ticks":4,"max_tick_us":2500}`))
	}))
	defer node.Close()
	nv := registry.NodeView{ID: "n1", Label: "Intercom", Online: true, APIBaseURL: node.URL}
	m := New(Services{Nodes: nodes{nv}, Instances: insts{}, HTTP: node.Client()})
	m.service(module.Deps{Settings: &memSettings{m: map[string][]byte{}}})
	var b strings.Builder
	m.WriteMetrics(&b)
	out := b.String()
	for _, want := range []string{`omp_intercom_parties{state="online"} 1`, `omp_intercom_parties{state="total"} 2`, "omp_intercom_late_ticks_total 4", "omp_intercom_max_tick_seconds 0.0025", "omp_intercom_underruns_total 5"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q fehlt in:\n%s", want, out)
		}
	}
	empty := New(Services{})
	var e strings.Builder
	empty.WriteMetrics(&e)
	if e.Len() != 0 {
		t.Error("ohne Dienst keine Zeilen")
	}
}

func TestNoNodeGivesClearError(t *testing.T) {
	m := New(Services{Nodes: nodes{}, Instances: insts{}})
	s := m.service(module.Deps{Settings: &memSettings{m: map[string][]byte{}}})
	if _, err := s.PanelURL(context.Background(), "x", "t"); err == nil {
		t.Fatal("Fehler erwartet")
	}
	if _, err := s.Status(context.Background()); err == nil {
		t.Fatal("Fehler erwartet")
	}
	s.Push(context.Background()) // darf nicht abstürzen
}

func TestOnlyLauncherInstancesOfTypeOrManualIntercomLabel(t *testing.T) {
	ns := nodes{
		{ID: "a", Label: "Etwas", Online: true, APIBaseURL: "http://a", InstanceID: "i-other"},
		{ID: "b", Label: "Intercom", Online: true, APIBaseURL: "http://b", InstanceID: "i-ic"},
		{ID: "c", Label: "Intercom-Test", Online: true, APIBaseURL: "http://c"},
		{ID: "d", Label: "Intercom", Online: false, APIBaseURL: "http://d", InstanceID: "i-ic"},
		{ID: "e", Label: "Intercom-X", Online: true, APIBaseURL: "http://e", InstanceID: "i-other"},
	}
	m := New(Services{Nodes: ns, Instances: insts{{ID: "i-ic", Type: "omp-intercom"}, {ID: "i-other", Type: "omp-source"}}})
	s := m.service(module.Deps{})
	var ids []string
	for _, n := range s.IntercomNodes() {
		ids = append(ids, n.ID)
	}
	if strings.Join(ids, ",") != "b,c" {
		t.Fatalf("Nodes: %v", ids)
	}
}

func TestHTTPHandlersConfigPanelsAndGuests(t *testing.T) {
	node := newFakeNode(t, false)
	s := testService(t, node)
	a := &api{svc: s}
	do := func(h http.HandlerFunc, method, path, body string, pv map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		for k, v := range pv {
			req.SetPathValue(k, v)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}
	b, _ := json.Marshal(sample())
	if rec := do(a.putConfig(), "PUT", "/x", string(b), nil); rec.Code != 200 || strings.Contains(rec.Body.String(), "\"token\"") {
		t.Fatalf("PUT: %d %s", rec.Code, rec.Body)
	}
	if rec := do(a.putConfig(), "PUT", "/x", `{"channels":[{"id":1}]}`, nil); rec.Code != 400 {
		t.Fatalf("ungültig: %d", rec.Code)
	}
	if rec := do(a.getConfig(), "GET", "/x", "", nil); rec.Code != 200 || strings.Contains(rec.Body.String(), "\"token\"") {
		t.Fatalf("GET liefert Token aus: %s", rec.Body)
	}
	// Bootstrap-Modus (kein Access): alle Teilnehmer außer Programmquellen.
	rec := do(a.panels(), "GET", "/x", "", nil)
	var pr struct {
		Panels []struct{ Name, URL string } `json:"panels"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pr)
	if len(pr.Panels) != 3 || !strings.Contains(pr.Panels[0].URL, "/panel?token=") {
		t.Fatalf("Panels: %s", rec.Body)
	}
	rec = do(a.createGuest(), "POST", "/x", `{"name":"Gast","ttl_minutes":60,"routes":[{"ch":1,"listen":true}]}`, nil)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), "token=") {
		t.Fatalf("Gast: %d %s", rec.Code, rec.Body)
	}
	if rec := do(a.deleteGuest(), "DELETE", "/x", "", map[string]string{"id": "x"}); rec.Code != 400 {
		t.Fatalf("ID: %d", rec.Code)
	}
	if rec := do(a.deleteGuest(), "DELETE", "/x", "", map[string]string{"id": "5"}); rec.Code != 404 {
		t.Fatalf("404 erwartet: %d", rec.Code)
	}
	if rec := do(a.status(), "GET", "/x", "", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "ticks") {
		t.Fatalf("Status: %d %s", rec.Code, rec.Body)
	}
}

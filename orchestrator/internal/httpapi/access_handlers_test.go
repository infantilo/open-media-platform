package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/accessrules"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sourcetags"
)

type fakeAccessEngine struct{ rules map[string][]accessrules.Rule }

func (f fakeAccessEngine) PolicyFor(u string) (*accessrules.Policy, error) {
	return accessrules.NewPolicy(f.rules[u]), nil
}

type fakeNodes struct{ list []registry.NodeView }

func (f fakeNodes) List() []registry.NodeView { return f.list }
func (f fakeNodes) Get(id string) (registry.NodeView, bool) {
	for _, n := range f.list {
		if n.ID == id {
			return n, true
		}
	}
	return registry.NodeView{}, false
}
func (f fakeNodes) PollDuration() time.Duration { return 0 }

type emptyTags struct{}

func (emptyTags) All() (map[sourcetags.Key][]string, error) {
	return map[sourcetags.Key][]string{}, nil
}
func (emptyTags) Set(k sourcetags.Key, tags []string, by string) ([]string, error) {
	return tags, nil
}

type fakeConfigureAuthz struct{ AuthzChecker }

func (f fakeConfigureAuthz) Check(subject, nodeID string, v authz.Verb) (bool, error) {
	return subject == "chef" && v == authz.VerbConfigure, nil
}

func accessTestChecker(rules map[string][]accessrules.Rule) *accessChecker {
	nodes := fakeNodes{list: []registry.NodeView{
		{ID: "cam", Label: "Kamera", Online: true, Senders: []registry.SenderView{{ID: "s-cam", Label: "Video", Format: "urn:x-nmos:format:video"}}},
		{ID: "geheim", Label: "Geheim", Online: true, Senders: []registry.SenderView{{ID: "s-geh", Label: "Video", Format: "urn:x-nmos:format:video"}}},
		{ID: "mon", Label: "Monitor", Online: true, Receivers: []registry.ReceiverView{{ID: "r-mon", Label: "In", Format: "urn:x-nmos:format:video"}}},
		{ID: "pgm", Label: "PGM", Online: true, Receivers: []registry.ReceiverView{{ID: "r-pgm", Label: "In", Format: "urn:x-nmos:format:video"}}},
	}}
	return &accessChecker{engine: fakeAccessEngine{rules: rules}, nodes: nodes, tags: emptyTags{}, authz: fakeConfigureAuthz{}}
}

func asUser(r *http.Request, user string) *http.Request {
	return r.WithContext(contextWithPrincipal(r.Context(), auth.Principal{Username: user}))
}

func TestAccessFiltersSourcesAndSinksPerUser(t *testing.T) {
	ac := accessTestChecker(map[string][]accessrules.Rule{
		"anna": {
			{SubjectType: "global", Kind: "source", Action: "see", Effect: "deny", SelectorType: "node", SelectorValue: "geheim"},
			{SubjectType: "user", Subject: "anna", Kind: "sink", Action: "see", Effect: "allow", SelectorType: "node", SelectorValue: "mon"},
		},
	})
	h := ac.filterSources(handleListSources(ac.nodes, emptyTags{}, nil, nil))
	rec := httptest.NewRecorder()
	h(rec, asUser(httptest.NewRequest("GET", "/api/v1/sources", nil), "anna"))
	var src []SourceInfo
	_ = json.Unmarshal(rec.Body.Bytes(), &src)
	if len(src) != 1 || src[0].SenderID != "s-cam" {
		t.Fatalf("Quellen für anna = %+v, want nur s-cam", src)
	}
	hs := ac.filterSinks(handleListSinks(ac.nodes, emptyTags{}, nil))
	rec = httptest.NewRecorder()
	hs(rec, asUser(httptest.NewRequest("GET", "/api/v1/sinks", nil), "anna"))
	var snk []SinkInfo
	_ = json.Unmarshal(rec.Body.Bytes(), &snk)
	if len(snk) != 1 || snk[0].ReceiverID != "r-mon" {
		t.Fatalf("Senken für anna (Freigabeliste) = %+v, want nur r-mon", snk)
	}
	// ein anderer Nutzer ohne Regeln sieht alles; Engineering (chef) unterliegt den Regeln nicht
	for _, u := range []string{"ben", "chef"} {
		rec = httptest.NewRecorder()
		h(rec, asUser(httptest.NewRequest("GET", "/api/v1/sources", nil), u))
		_ = json.Unmarshal(rec.Body.Bytes(), &src)
		if len(src) != 2 {
			t.Fatalf("Quellen für %s = %d, want 2", u, len(src))
		}
	}
}

func TestAccessGuardsSwitching(t *testing.T) {
	ac := accessTestChecker(map[string][]accessrules.Rule{
		"anna": {{SubjectType: "global", Kind: "sink", Action: "route", Effect: "deny", SelectorType: "node", SelectorValue: "pgm"},
			{SubjectType: "global", Kind: "source", Action: "route", Effect: "deny", SelectorType: "node", SelectorValue: "geheim"}},
	})
	called := 0
	next := func(w http.ResponseWriter, r *http.Request) { called++; w.WriteHeader(http.StatusOK) }
	post := ac.guardEdgePost(next)
	try := func(from, to string) int {
		body, _ := json.Marshal(map[string]string{"from": from, "to": to})
		rec := httptest.NewRecorder()
		post(rec, asUser(httptest.NewRequest("POST", "/api/v1/graph/edges", bytes.NewReader(body)), "anna"))
		return rec.Code
	}
	if c := try("s-cam", "r-mon"); c != 200 {
		t.Fatalf("erlaubte Schaltung = %d", c)
	}
	if c := try("s-cam", "r-pgm"); c != 403 {
		t.Fatalf("gesperrte Senke = %d, want 403", c)
	}
	if c := try("s-geh", "r-mon"); c != 403 {
		t.Fatalf("gesperrte Quelle = %d, want 403", c)
	}
	if called != 1 {
		t.Fatalf("next wurde %d× aufgerufen, want 1", called)
	}
	del := ac.guardEdgeDelete(next)
	req := asUser(httptest.NewRequest("DELETE", "/api/v1/graph/edges/r-pgm", nil), "anna")
	req.SetPathValue("id", "r-pgm")
	rec := httptest.NewRecorder()
	del(rec, req)
	if rec.Code != 403 {
		t.Fatalf("Trennen an gesperrter Senke = %d, want 403", rec.Code)
	}
}

func TestAccessFiltersGraph(t *testing.T) {
	ac := accessTestChecker(map[string][]accessrules.Rule{
		"anna": {{SubjectType: "global", Kind: "source", Action: "see", Effect: "deny", SelectorType: "node", SelectorValue: "geheim"}},
	})
	g := graph.Graph{
		Nodes: []graph.Node{
			{ID: "cam", Outputs: []graph.Port{{ID: "s-cam"}}},
			{ID: "geheim", Outputs: []graph.Port{{ID: "s-geh"}}},
			{ID: "mon", Inputs: []graph.Port{{ID: "r-mon"}}},
		},
		Edges: []graph.Edge{{ID: "r-mon", FromSender: "s-geh", ToReceiver: "r-mon"}},
	}
	h := ac.filterGraph(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, g) })
	rec := httptest.NewRecorder()
	h(rec, asUser(httptest.NewRequest("GET", "/api/v1/graph", nil), "anna"))
	var out graph.Graph
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Nodes[1].Outputs) != 0 || len(out.Nodes[0].Outputs) != 1 {
		t.Fatalf("Ausgänge = %+v", out.Nodes)
	}
	if len(out.Edges) != 0 {
		t.Fatalf("Kante zu einer nicht sichtbaren Quelle muss fehlen: %+v", out.Edges)
	}
}

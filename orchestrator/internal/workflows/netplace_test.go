package workflows

import (
	"reflect"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/maintenance"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
)

// groupResources: Verbund-Platzierung als Double — alle Mitglieder auf target, außer split.
type groupResources struct {
	planResources
	target string
	split  bool
	over   bool
	calls  int
}

func (g *groupResources) SelectHostGroup(ms []placement.GroupMember, _ []placement.Link, _ placement.Occupancy) placement.GroupResult {
	g.calls++
	r := placement.GroupResult{Hosts: map[string]string{}, Reason: "Verbund", Split: g.split, Overloaded: g.over}
	target := g.target
	for _, m := range ms {
		if m.Fixed != "" && !g.split {
			target = m.Fixed // wie die Engine: ein fester Host zieht den Verbund, wenn er ihn trägt
			break
		}
	}
	for i, m := range ms {
		h := target
		if g.split && i > 0 {
			h = "other"
		}
		if m.Fixed != "" {
			h = m.Fixed
		}
		r.Hosts[m.Name] = h
	}
	return r
}

func TestRoleLinksGatewayConnectionsDoNotBind(t *testing.T) {
	def := Definition{
		Roles: []Role{{Name: "src", NodeType: "omp-source"}, {Name: "mix", NodeType: "omp-video-mixer-me"}, {Name: "srt", NodeType: "omp-srt-out"}},
		Connections: []Connection{
			{FromRole: "src", ToRole: "mix"}, {FromRole: "src", ToRole: "mix", ToReceiver: "b"}, // doppelt -> einmal
			{FromRole: "mix", ToRole: "srt"}, {FromRole: "mix", ToRole: "mix"}, {FromRole: "x", ToRole: "mix"},
		},
	}
	cat := []launcher.CatalogEntry{{Type: "omp-srt-out", Network: &launcher.CatalogNetwork{}}}
	got := roleLinks(def, cat)
	want := []placement.Link{{A: "src", B: "mix", Bound: true}, {A: "mix", B: "srt", Bound: false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v, want %+v", got, want)
	}
}

func TestPlanStartPlacesMXLConnectedRolesTogether(t *testing.T) {
	res := &groupResources{planResources: planResources{
		hostFor: map[string]string{"omp-source": "hostA", "omp-video-mixer-me": "hostB", "omp-viewer": "hostA"},
		cpu:     map[string]float64{}, limit: 85, base: map[string]float64{},
	}, target: "hostB"}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "omp-source"}, {Name: "mix", NodeType: "omp-video-mixer-me"}, {Name: "solo", NodeType: "omp-viewer"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "mix"}},
	}
	plan := svc.planFor(Workflow{ID: "w", Definition: def, Status: StatusStopped})
	got := map[string]string{}
	for _, r := range plan.Roles {
		got[r.Role] = r.PlannedHostID
	}
	if got["src"] != "hostB" || got["mix"] != "hostB" || got["solo"] != "hostA" {
		t.Fatalf("Verbund gemeinsam, Einzelrolle eigene Wahl: %v", got)
	}
	if res.calls != 1 {
		t.Errorf("Verbund einmal berechnet, nicht je Rolle: %d", res.calls)
	}
}

func TestStartPlacerFixedRoleDragsGroupAndNetworkPeerIsPreferred(t *testing.T) {
	res := &groupResources{planResources: planResources{hostFor: map[string]string{"t": "free"}}, target: "free"}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	def := Definition{
		Roles:       []Role{{Name: "card", NodeType: "t"}, {Name: "view", NodeType: "t"}, {Name: "out", NodeType: "t"}},
		Connections: []Connection{{FromRole: "card", ToRole: "view"}},
	}
	p := svc.newStartPlacer(def, map[string]string{"card": "hostIO"}, placement.Occupancy{})
	if p.group["card"].HostID != "hostIO" || p.group["view"].HostID != "hostIO" {
		t.Fatalf("fester Host zieht den Verbund: %+v", p.group)
	}
	// Netzwerk-Link out<-view: out bevorzugt den Host von view
	p.links = append(p.links, placement.Link{A: "view", B: "out", Bound: false})
	if r := p.place(def.Roles[2], placement.Occupancy{}); r.HostID != "hostIO" {
		t.Fatalf("Netzwerk-Gegenstelle bevorzugt: %+v", r)
	}
	// eigener Host der Rolle gewinnt gegen die Vorliebe
	if r := p.place(Role{Name: "out", NodeType: "t", HostID: "mine"}, placement.Occupancy{}); r.HostID != "mine" {
		t.Fatalf("Rollenhost: %+v", r)
	}
}

func TestPeerHost(t *testing.T) {
	wf := Workflow{Runtime: map[string]RoleRuntime{
		"a": {InstanceID: "i1", HostID: "h1"}, "b": {InstanceID: "i2", HostID: "h1"}, "c": {InstanceID: "i3", HostID: "h2"}, "d": {},
	}}
	links := []placement.Link{{A: "a", B: "b", Bound: true}, {A: "a", B: "c", Bound: false}, {A: "a", B: "d", Bound: true}}
	if h, ok := peerHost(wf, links, "a"); !ok || h != "h1" {
		t.Errorf("a: %q %v (Netzwerk-Kante und nicht laufende Rolle zählen nicht)", h, ok)
	}
	if h, ok := peerHost(wf, links, "b"); !ok || h != "h1" {
		t.Errorf("b: %q %v", h, ok)
	}
	if _, ok := peerHost(wf, []placement.Link{{A: "a", B: "b", Bound: true}, {A: "a", B: "c", Bound: true}}, "a"); ok {
		t.Error("uneinige Gegenstellen dürfen keinen Host liefern")
	}
	if _, ok := peerHost(wf, links, "zzz"); ok {
		t.Error("unbekannte Rolle")
	}
}

func evacWorkflow() (Workflow, []maintenance.Item) {
	wf := Workflow{ID: "w", Definition: Definition{
		Roles:       []Role{{Name: "src", NodeType: "t"}, {Name: "mix", NodeType: "t"}, {Name: "solo", NodeType: "t"}, {Name: "away", NodeType: "t"}},
		Connections: []Connection{{FromRole: "src", ToRole: "mix"}, {FromRole: "mix", ToRole: "away"}},
	}, Runtime: map[string]RoleRuntime{}}
	items := []maintenance.Item{
		{WorkflowID: "w", Role: "src", InstanceID: "i-src"}, {WorkflowID: "w", Role: "mix", InstanceID: "i-mix"}, {WorkflowID: "w", Role: "solo", InstanceID: "i-solo"},
	}
	return wf, items // "away" läuft nicht auf dem zu räumenden Host
}

func TestEvacuationTargetMovesConnectedRolesToOneHost(t *testing.T) {
	res := &groupResources{planResources: planResources{hostFor: map[string]string{"t": "solo-host"}}, target: "hostB"}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	wf, items := evacWorkflow()
	wf.Runtime = map[string]RoleRuntime{"src": {InstanceID: "i-src", HostID: "hostA"}, "mix": {InstanceID: "i-mix", HostID: "hostA"}, "solo": {InstanceID: "i-solo", HostID: "hostA"}, "away": {InstanceID: "i-away", HostID: "hostZ"}}
	cache := map[string]placement.GroupResult{}

	for _, role := range []string{"src", "mix"} {
		it := items[0]
		if role == "mix" {
			it = items[1]
		}
		h, why := svc.evacuationTarget(wf, it, items, "hostA", cache)
		if why != "" || h != "hostZ" { // das schon auf hostZ laufende Mitglied „away“ zieht den Verbund dorthin
			t.Fatalf("%s: %q %q", role, h, why)
		}
	}
	if res.calls != 1 {
		t.Errorf("Verbund einmal berechnet: %d", res.calls)
	}
	peers := svc.groupPeerInstances(wf)
	for _, id := range []string{"i-src", "i-mix", "i-away"} { // away liegt woanders und gehört zum Verbund (src–mix–away)
		if !peers[id] {
			t.Errorf("%s gehört zum geplanten Umzug: %v", id, peers)
		}
	}
	if peers["i-solo"] {
		t.Error("Einzelrolle ist kein Verbund-Umzug")
	}
	// Einzelrolle: normale Wahl; gleicher Host wie Quelle ⇒ kein Ziel
	if h, why := svc.evacuationTarget(wf, items[2], items, "hostA", cache); h != "solo-host" || why != "" {
		t.Errorf("solo: %q %q", h, why)
	}
	if h, why := svc.evacuationTarget(wf, items[2], items, "solo-host", cache); h != "" || why == "" {
		t.Errorf("solo auf Quellhost: %q %q", h, why)
	}
}

// Aufteilung ist erlaubt (möglichst wenig Querverbindungen entscheidet die Platzierung): jede Rolle bekommt ihr eigenes Ziel.
func TestEvacuationTargetFollowsSplitPlan(t *testing.T) {
	res := &groupResources{planResources: planResources{}, target: "hostB", split: true}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	wf, items := evacWorkflow()
	wf.Runtime = map[string]RoleRuntime{"src": {InstanceID: "i-src", HostID: "hostA"}, "mix": {InstanceID: "i-mix", HostID: "hostA"}, "away": {InstanceID: "i-away", HostID: "hostZ"}}
	cache := map[string]placement.GroupResult{}
	h0, why0 := svc.evacuationTarget(wf, items[0], items, "hostA", cache)
	h1, why1 := svc.evacuationTarget(wf, items[1], items, "hostA", cache)
	if why0 != "" || why1 != "" || h0 == "" || h1 == "" || h0 == h1 {
		t.Fatalf("Aufteilung erwartet: %q/%q %q/%q", h0, why0, h1, why1)
	}
	if !svc.groupPeerInstances(wf)["i-mix"] {
		t.Error("beide gehören zum geplanten Umzug")
	}
}

func TestEvacuationTargetRefusesOverloadedHostForGroup(t *testing.T) {
	res := &groupResources{planResources: planResources{}, target: "hostB", over: true}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	wf, items := evacWorkflow()
	wf.Runtime = map[string]RoleRuntime{"src": {InstanceID: "i-src", HostID: "hostA"}, "mix": {InstanceID: "i-mix", HostID: "hostA"}}
	h, why := svc.evacuationTarget(wf, items[0], items, "hostA", map[string]placement.GroupResult{})
	if h != "" || !containsSub(why, "Reserve") {
		t.Fatalf("%q %q", h, why)
	}
	if len(svc.groupPeerInstances(wf)) != 0 {
		t.Error("keine Umzugs-Marke bei Überlast")
	}
}

func TestGroupMigrationTargetStaysOrMovesWholePlan(t *testing.T) {
	res := &groupResources{planResources: planResources{cpu: map[string]float64{"t": 10}}, target: "hostB"}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	wf, _ := evacWorkflow()
	wf.ID = "w"
	wf.Runtime = map[string]RoleRuntime{"src": {InstanceID: "i-src", HostID: "hostA"}, "mix": {InstanceID: "i-mix", HostID: "hostA"}, "solo": {InstanceID: "i-solo", HostID: "hostA"}}
	if h, ok := svc.groupMigrationTarget(wf, "src", "hostA"); !ok || h != "hostB" {
		t.Fatalf("Verbund zieht um: %q %v", h, ok)
	}
	if !svc.groupPeerInstances(wf)["i-mix"] {
		t.Error("Mitglieder sind markiert")
	}
	if _, ok := svc.groupMigrationTarget(wf, "solo", "hostA"); ok {
		t.Error("Einzelrolle: keine Verbund-Logik")
	}
	res.over = true
	if h, ok := svc.groupMigrationTarget(wf, "src", "hostA"); !ok || h != "hostA" {
		t.Fatalf("Überlast: Verbund bleibt: %q %v", h, ok)
	}
}

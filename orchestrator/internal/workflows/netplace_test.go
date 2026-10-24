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
	calls  int
}

func (g *groupResources) SelectHostGroup(ms []placement.GroupMember, _ placement.Occupancy) placement.GroupResult {
	g.calls++
	r := placement.GroupResult{Hosts: map[string]string{}, Reason: "Verbund", Split: g.split}
	target := g.target
	for _, m := range ms {
		if m.Fixed != "" {
			target = m.Fixed // wie die Engine: ein fester Host zieht den Verbund
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
	cache := map[string]placement.GroupResult{}

	for _, role := range []string{"src", "mix"} {
		it := items[0]
		if role == "mix" {
			it = items[1]
		}
		h, why := svc.evacuationTarget(wf, it, items, "hostA", cache)
		if why != "" || h != "hostB" {
			t.Fatalf("%s: %q %q", role, h, why)
		}
	}
	if res.calls != 1 {
		t.Errorf("Verbund einmal berechnet: %d", res.calls)
	}
	for _, id := range []string{"i-src", "i-mix"} {
		if v, ok := svc.groupMoves.Load(id); !ok || v.(string) != "hostB" {
			t.Errorf("groupMoves[%s] = %v %v", id, v, ok)
		}
	}
	if _, ok := svc.groupMoves.Load("i-solo"); ok {
		t.Error("Einzelrolle ist kein Gruppenumzug")
	}
	// Einzelrolle: normale Wahl; gleicher Host wie Quelle ⇒ kein Ziel
	if h, why := svc.evacuationTarget(wf, items[2], items, "hostA", cache); h != "solo-host" || why != "" {
		t.Errorf("solo: %q %q", h, why)
	}
	if h, why := svc.evacuationTarget(wf, items[2], items, "solo-host", cache); h != "" || why == "" {
		t.Errorf("solo auf Quellhost: %q %q", h, why)
	}
}

func TestEvacuationTargetRefusesToSplitGroup(t *testing.T) {
	res := &groupResources{planResources: planResources{}, target: "hostB", split: true}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	wf, items := evacWorkflow()
	h, why := svc.evacuationTarget(wf, items[0], items, "hostA", map[string]placement.GroupResult{})
	if h != "" || why == "" {
		t.Fatalf("Verbund darf nicht zerrissen werden: %q %q", h, why)
	}
	if _, ok := svc.groupMoves.Load("i-src"); ok {
		t.Error("bei Aufteilung keine Gruppenumzug-Marke")
	}
}

func TestPlanStartWarnsAboutMXLLinkAcrossHosts(t *testing.T) {
	res := &groupResources{planResources: planResources{hostFor: map[string]string{}, cpu: map[string]float64{}, limit: 85, base: map[string]float64{}}, target: "hostB", split: true}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	def := Definition{
		Roles:       []Role{{Name: "a", NodeType: "t", HostID: "h1"}, {Name: "b", NodeType: "t", HostID: "h2"}},
		Connections: []Connection{{FromRole: "a", ToRole: "b"}},
	}
	// Verbund passt auf keinen Host (split): die Vorschau warnt
	plan := svc.planFor(Workflow{ID: "w", Definition: def, Status: StatusStopped})
	found := false
	for _, w := range plan.Warnings {
		if containsSub(w, "MXL") && containsSub(w, "verschiedenen Hosts") {
			found = true
		}
	}
	if !found {
		t.Fatalf("Warnung fehlt (Rollen: %+v, Warnungen: %v)", plan.Roles, plan.Warnings)
	}
}

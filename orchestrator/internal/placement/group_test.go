package placement

import (
	"reflect"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

func TestComponents(t *testing.T) {
	names := []string{"a", "b", "c", "d", "e"}
	cases := []struct {
		name  string
		links []Link
		want  [][]string
	}{
		{"keine Links", nil, [][]string{{"a"}, {"b"}, {"c"}, {"d"}, {"e"}}},
		{"Kette", []Link{{"a", "b", true}, {"b", "c", true}}, [][]string{{"a", "b", "c"}, {"d"}, {"e"}}},
		{"zwei Verbünde", []Link{{"a", "b", true}, {"d", "e", true}}, [][]string{{"a", "b"}, {"c"}, {"d", "e"}}},
		{"Netzwerk-Kante trennt", []Link{{"a", "b", true}, {"b", "c", false}}, [][]string{{"a", "b"}, {"c"}, {"d"}, {"e"}}},
		{"Reihenfolge der Kante egal, Brücke verbindet", []Link{{"c", "a", true}, {"e", "c", true}}, [][]string{{"a", "c", "e"}, {"b"}, {"d"}}},
		{"unbekannte Namen", []Link{{"a", "zzz", true}}, [][]string{{"a"}, {"b"}, {"c"}, {"d"}, {"e"}}},
	}
	for _, c := range cases {
		if got := Components(names, c.links); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func groupEngine(m fakeMetrics, p fakeProfiles, ids ...string) *Engine {
	var hs []hosts.Host
	for _, id := range ids {
		hs = append(hs, hosts.Host{ID: id, Label: id})
	}
	return NewEngine(fakeHosts{hosts: hs}, m, fakeInstances{}, nil, testThresholds(), p)
}

func emptyOcc() Occupancy {
	return Occupancy{AffinityGroupHosts: map[string][]string{}, RedundancyGroupHosts: map[string][]string{}, ExtraLoad: map[string]profiles.Snapshot{}}
}

func gm(name, typ string) GroupMember {
	return GroupMember{Name: name, Req: PlacementRequest{NodeType: typ}}
}

func TestSelectHostGroupKeepsGroupTogetherOnLeastLoaded(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 40}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	r := e.SelectHostGroup([]GroupMember{gm("src", "s"), gm("view", "v")}, emptyOcc())
	if r.Split || r.Hosts["src"] != "h2" || r.Hosts["view"] != "h2" {
		t.Fatalf("%+v", r)
	}
	if !strings.Contains(r.Reason, "gemeinsam") {
		t.Errorf("Begründung: %q", r.Reason)
	}
}

func TestSelectHostGroupSumsLoadOfAllMembers(t *testing.T) {
	// h2 ist leerer, aber die beiden Mitglieder zusammen sprengen 85 %; h1 trägt sie.
	p := fakeProfiles{{"big", "h2"}: {CPUAvg: 50}, {"big2", "h2"}: {CPUAvg: 50}, {"big", "h1"}: {CPUAvg: 5}, {"big2", "h1"}: {CPUAvg: 5}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 60}, "h2": {CPUPercent: 10}}, p, "h1", "h2")
	r := e.SelectHostGroup([]GroupMember{gm("a", "big"), gm("b", "big2")}, emptyOcc())
	if r.Split || r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupSplitsWhenNothingFits(t *testing.T) {
	p := fakeProfiles{{"big", "h1"}: {CPUAvg: 50}, {"big", "h2"}: {CPUAvg: 50}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, p, "h1", "h2")
	r := e.SelectHostGroup([]GroupMember{gm("a", "big"), gm("b", "big")}, emptyOcc())
	if !r.Split || r.Hosts["a"] == r.Hosts["b"] || !strings.Contains(r.Reason, "aufgeteilt") {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupPreferredHostWinsIfItFits(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 40}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	m := []GroupMember{gm("a", "x"), {Name: "b", Req: PlacementRequest{NodeType: "x", PreferredHostID: "h1"}}}
	r := e.SelectHostGroup(m, emptyOcc())
	if r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupRedundancyAvoidsHostWithFallback(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 30}}, nil, "h1", "h2")
	occ := emptyOcc()
	occ.RedundancyGroupHosts["pair"] = []string{"h1"}
	m := []GroupMember{{Name: "a", Req: PlacementRequest{NodeType: "x", RedundancyGroup: "pair"}}, gm("b", "x")}
	if r := e.SelectHostGroup(m, occ); r.Hosts["a"] != "h2" || r.Hosts["b"] != "h2" {
		t.Fatalf("Ausweichen: %+v", r)
	}
	occ.RedundancyGroupHosts["pair"] = []string{"h1", "h2"}
	r := e.SelectHostGroup(m, occ)
	if r.Hosts["a"] != "h1" || !strings.Contains(r.Reason, "Redundanz-Konflikt") {
		t.Fatalf("Rückfall: %+v", r)
	}
}

func TestSelectHostGroupAffinityBeatsLoad(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 50}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	occ := emptyOcc()
	occ.AffinityGroupHosts["g"] = []string{"h1"}
	m := []GroupMember{{Name: "a", Req: PlacementRequest{NodeType: "x", AffinityGroup: "g"}}, gm("b", "x")}
	if r := e.SelectHostGroup(m, occ); r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupFixedHostPullsGroup(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	m := []GroupMember{{Name: "card", Req: PlacementRequest{NodeType: "io"}, Fixed: "h2"}, gm("view", "v")}
	r := e.SelectHostGroup(m, emptyOcc())
	if r.Split || r.Hosts["card"] != "h2" || r.Hosts["view"] != "h2" {
		t.Fatalf("%+v", r)
	}
	m = []GroupMember{{Name: "c1", Fixed: "h1"}, {Name: "c2", Fixed: "h2"}, gm("v", "v")}
	r = e.SelectHostGroup(m, emptyOcc())
	if !r.Split || r.Hosts["v"] != "h1" {
		t.Fatalf("zwei feste Hosts: %+v", r)
	}
}

func TestSelectHostGroupSkipsOfflineAndMaintenance(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 20}}, nil, "h1", "h2", "h3") // h3 ohne Telemetrie = offline
	e.SetMaintenance("h1", true)
	r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, emptyOcc())
	if r.Hosts["a"] != "h2" || r.Hosts["b"] != "h2" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupNoRemoteHostsStaysLocalNotSplit(t *testing.T) {
	e := groupEngine(fakeMetrics{}, nil)
	r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, emptyOcc())
	if r.Split || r.Hosts["a"] != "" || r.Hosts["b"] != "" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupDeterministic(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 20}, "h2": {CPUPercent: 20}}, nil, "h1", "h2")
	first := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, emptyOcc())
	for i := 0; i < 20; i++ {
		if r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, emptyOcc()); !reflect.DeepEqual(r, first) {
			t.Fatalf("nicht deterministisch: %+v vs %+v", r, first)
		}
	}
}

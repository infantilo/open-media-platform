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
		{"Kette", []Link{{A: "a", B: "b", Bound: true}, {A: "b", B: "c", Bound: true}}, [][]string{{"a", "b", "c"}, {"d"}, {"e"}}},
		{"zwei Verbünde", []Link{{A: "a", B: "b", Bound: true}, {A: "d", B: "e", Bound: true}}, [][]string{{"a", "b"}, {"c"}, {"d", "e"}}},
		{"Netzwerk-Kante trennt", []Link{{A: "a", B: "b", Bound: true}, {A: "b", B: "c", Bound: false}}, [][]string{{"a", "b"}, {"c"}, {"d"}, {"e"}}},
		{"Reihenfolge der Kante egal, Brücke verbindet", []Link{{A: "c", B: "a", Bound: true}, {A: "e", B: "c", Bound: true}}, [][]string{{"a", "c", "e"}, {"b"}, {"d"}}},
		{"unbekannte Namen", []Link{{A: "a", B: "zzz", Bound: true}}, [][]string{{"a"}, {"b"}, {"c"}, {"d"}, {"e"}}},
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
	r := e.SelectHostGroup([]GroupMember{gm("src", "s"), gm("view", "v")}, nil, emptyOcc())
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
	r := e.SelectHostGroup([]GroupMember{gm("a", "big"), gm("b", "big2")}, nil, emptyOcc())
	if r.Split || r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func chain(names ...string) []Link {
	var ls []Link
	for i := 0; i+1 < len(names); i++ {
		ls = append(ls, Link{A: names[i], B: names[i+1], Bound: true})
	}
	return ls
}

// Vier Rollen à 40 % passen nie auf einen Host (Grenze 85 %), zwei je Host schon. Kette a–b–c–d: der Schnitt zwischen b und c
// kreuzt nur eine Verbindung, jede andere Aufteilung mehr.
func TestSelectHostGroupSplitsWithMinimalCut(t *testing.T) {
	p := fakeProfiles{{"big", "h1"}: {CPUAvg: 20}, {"big", "h2"}: {CPUAvg: 20}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, p, "h1", "h2")
	ms := []GroupMember{gm("a", "big"), gm("b", "big"), gm("c", "big"), gm("d", "big")}
	// 10 + 4×20 = 90 ≥ 85 → ein Host trägt höchstens drei … mit 4 Mitgliedern aber nicht alle
	r := e.SelectHostGroup(ms, chain("a", "b", "c", "d"), emptyOcc())
	if !r.Split || r.Overloaded {
		t.Fatalf("Aufteilung erwartet: %+v", r)
	}
	if len(r.Cut) != 1 || r.CutWeight != 1 {
		t.Fatalf("Schnitt %v (%.0f), want 1", r.Cut, r.CutWeight)
	}
	same := func(x, y string) bool { return r.Hosts[x] == r.Hosts[y] }
	if !(same("a", "b") && same("c", "d") && !same("b", "c")) && !(same("a", "b") && same("b", "c") && !same("c", "d")) && !(same("b", "c") && same("c", "d") && !same("a", "b")) {
		t.Fatalf("Schnitt muss an einer Kettenstelle liegen: %+v", r.Hosts)
	}
	if !strings.Contains(r.Reason, "aufgeteilt") || !strings.Contains(r.Reason, "→") {
		t.Errorf("Begründung: %q", r.Reason)
	}
}

func TestSelectHostGroupCutUsesWeights(t *testing.T) {
	p := fakeProfiles{{"big", "h1"}: {CPUAvg: 30}, {"big", "h2"}: {CPUAvg: 30}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, p, "h1", "h2")
	ms := []GroupMember{gm("a", "big"), gm("b", "big"), gm("c", "big"), gm("d", "big")}
	// a–b und c–d sind schwer (RDMA-Bandbreite), b–c leicht: dort wird geschnitten, nicht anderswo
	links := []Link{{A: "a", B: "b", Bound: true, Weight: 10}, {A: "b", B: "c", Bound: true, Weight: 1}, {A: "c", B: "d", Bound: true, Weight: 10}}
	r := e.SelectHostGroup(ms, links, emptyOcc())
	if !r.Split || r.CutWeight != 1 || r.Hosts["a"] != r.Hosts["b"] || r.Hosts["c"] != r.Hosts["d"] || r.Hosts["b"] == r.Hosts["c"] {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupOverloadedWhenEvenSplitCannotFit(t *testing.T) {
	p := fakeProfiles{{"big", "h1"}: {CPUAvg: 80}, {"big", "h2"}: {CPUAvg: 80}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 30}}, p, "h1", "h2")
	r := e.SelectHostGroup([]GroupMember{gm("a", "big"), gm("b", "big")}, chain("a", "b"), emptyOcc())
	if r.Split || !r.Overloaded || r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" || !strings.Contains(r.Reason, "Überlast") {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupPrefersSingleHostOverSplit(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, chain("a", "b"), emptyOcc())
	if r.Split || len(r.Cut) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupCreditCountsStayingMembersOnce(t *testing.T) {
	// Host h1 misst 80 % — davon 2×20 % durch die Mitglieder selbst. Ohne Gutschrift passt der Verbund dort nicht mehr.
	p := fakeProfiles{{"x", "h1"}: {CPUAvg: 20}, {"x", "h2"}: {CPUAvg: 20}}
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 60}, "h2": {CPUPercent: 80}}, p, "h1", "h2")
	ms := []GroupMember{{Name: "a", Req: PlacementRequest{NodeType: "x", PreferredHostID: "h1"}}, gm("b", "x")}
	r := e.SelectHostGroup(ms, chain("a", "b"), emptyOcc())
	if !r.Overloaded {
		t.Fatalf("ohne Gutschrift darf der Verbund nirgends passen: %+v", r)
	}
	occ := emptyOcc()
	occ.Credit = map[string]profiles.Snapshot{"h1": {CPUAvg: 40}}
	r = e.SelectHostGroup(ms, chain("a", "b"), occ)
	if r.Split || r.Overloaded || r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("mit Gutschrift bleibt der Verbund: %+v", r)
	}
}

func TestSelectHostGroupPreferredHostWinsIfItFits(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 40}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	m := []GroupMember{gm("a", "x"), {Name: "b", Req: PlacementRequest{NodeType: "x", PreferredHostID: "h1"}}}
	r := e.SelectHostGroup(m, nil, emptyOcc())
	if r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupRedundancyAvoidsHostWithFallback(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 30}}, nil, "h1", "h2")
	occ := emptyOcc()
	occ.RedundancyGroupHosts["pair"] = []string{"h1"}
	m := []GroupMember{{Name: "a", Req: PlacementRequest{NodeType: "x", RedundancyGroup: "pair"}}, gm("b", "x")}
	if r := e.SelectHostGroup(m, nil, occ); r.Hosts["a"] != "h2" || r.Hosts["b"] != "h2" {
		t.Fatalf("Ausweichen: %+v", r)
	}
	occ.RedundancyGroupHosts["pair"] = []string{"h1", "h2"}
	r := e.SelectHostGroup(m, nil, occ)
	if r.Hosts["a"] != "h1" || !strings.Contains(r.Reason, "Redundanz-Konflikt") {
		t.Fatalf("Rückfall: %+v", r)
	}
}

func TestSelectHostGroupAffinityBeatsLoad(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 50}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	occ := emptyOcc()
	occ.AffinityGroupHosts["g"] = []string{"h1"}
	m := []GroupMember{{Name: "a", Req: PlacementRequest{NodeType: "x", AffinityGroup: "g"}}, gm("b", "x")}
	if r := e.SelectHostGroup(m, nil, occ); r.Hosts["a"] != "h1" || r.Hosts["b"] != "h1" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupFixedHostPullsGroup(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 10}}, nil, "h1", "h2")
	m := []GroupMember{{Name: "card", Req: PlacementRequest{NodeType: "io"}, Fixed: "h2"}, gm("view", "v")}
	r := e.SelectHostGroup(m, nil, emptyOcc())
	if r.Split || r.Hosts["card"] != "h2" || r.Hosts["view"] != "h2" {
		t.Fatalf("%+v", r)
	}
	m = []GroupMember{{Name: "c1", Fixed: "h1"}, {Name: "c2", Fixed: "h2"}, gm("v", "v")}
	r = e.SelectHostGroup(m, nil, emptyOcc())
	if !r.Split || r.Hosts["c1"] != "h1" || r.Hosts["c2"] != "h2" {
		t.Fatalf("zwei feste Hosts: %+v", r)
	}
}

func TestSelectHostGroupSkipsOfflineAndMaintenance(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 10}, "h2": {CPUPercent: 20}}, nil, "h1", "h2", "h3") // h3 ohne Telemetrie = offline
	e.SetMaintenance("h1", true)
	r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, nil, emptyOcc())
	if r.Hosts["a"] != "h2" || r.Hosts["b"] != "h2" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupNoRemoteHostsStaysLocalNotSplit(t *testing.T) {
	e := groupEngine(fakeMetrics{}, nil)
	r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, nil, emptyOcc())
	if r.Split || r.Hosts["a"] != "" || r.Hosts["b"] != "" {
		t.Fatalf("%+v", r)
	}
}

func TestSelectHostGroupDeterministic(t *testing.T) {
	e := groupEngine(fakeMetrics{"h1": {CPUPercent: 20}, "h2": {CPUPercent: 20}}, nil, "h1", "h2")
	first := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, nil, emptyOcc())
	for i := 0; i < 20; i++ {
		if r := e.SelectHostGroup([]GroupMember{gm("a", "x"), gm("b", "x")}, nil, emptyOcc()); !reflect.DeepEqual(r, first) {
			t.Fatalf("nicht deterministisch: %+v vs %+v", r, first)
		}
	}
}

// Verbrauchsprofile sind Prozent eines Kerns, die Host-Telemetrie Prozent der Maschine: auf einem 8-Kern-Host trägt die
// Last zweier Rollen à 64 % (je 8 % der Maschine) problemlos; ohne Kernzahl würde sie 128 % zählen.
func TestScoreHostNormalizesProfilesByCoreCount(t *testing.T) {
	p := fakeProfiles{{"src", "h1"}: {CPUAvg: 64}}
	hs := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "h1", Capabilities: []byte(`{"numCPU":8}`)}}}
	e := NewEngine(hs, fakeMetrics{"h1": {CPUPercent: 14}}, fakeInstances{}, nil, testThresholds(), p)
	r := e.SelectHostGroup([]GroupMember{gm("a", "src"), gm("b", "src")}, chain("a", "b"), emptyOcc())
	if r.Split || r.Overloaded || r.Hosts["a"] != "h1" {
		t.Fatalf("2 × 64 %% eines Kerns = 16 %% der Maschine passen: %+v", r)
	}
	s := e.scoreHost("h1", "src", profiles.Snapshot{})
	if s.cpuPercent < 21.9 || s.cpuPercent > 22.1 {
		t.Fatalf("14 + 64/8 = 22, bekam %.2f", s.cpuPercent)
	}
	// ohne bekannte Kernzahl bleibt es beim bisherigen Verhalten
	e2 := groupEngine(fakeMetrics{"h1": {CPUPercent: 14}}, p, "h1")
	if s := e2.scoreHost("h1", "src", profiles.Snapshot{}); s.cpuPercent != 78 {
		t.Fatalf("ohne Kernzahl 14 + 64, bekam %.2f", s.cpuPercent)
	}
}

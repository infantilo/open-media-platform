// Netzwerkarme Platzierung (ARCHITECTURE.md §31, UMSETZUNG.md Kapitel 56):
// Rollen, die über MXL verbunden sind, bilden einen Verbund und werden als
// Einheit auf EINEM Host platziert — MXL ist host-lokal, ein Verbund über
// mehrere Hosts hätte keinen Signalweg. Verbindungen über Netzwerk-Gateways
// binden nicht hart, bevorzugen aber denselben Host (weniger Querverkehr).
// Kein Lernverfahren: deterministische Filter + Lastvergleich wie SelectHost.
package placement

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// Link verbindet zwei Rollen eines Starts. Bound=true: MXL (beide Enden müssen auf einen Host),
// false: Netzwerkweg (nur Vorliebe für denselben Host).
type Link struct {
	A, B  string
	Bound bool
	// Weight: Gewicht der Verbindung beim Aufteilen (z. B. Bandbreite); 0 = 1.
	Weight float64
}

func (l Link) weight() float64 {
	if l.Weight <= 0 {
		return 1
	}
	return l.Weight
}

// Components liefert die Verbünde: Zusammenhangskomponenten der Rollen über Bound-Links.
// Reihenfolge stabil (nach erster Nennung in names, Mitglieder in names-Reihenfolge);
// Rollen ohne Bound-Link bilden einen Verbund aus einem Mitglied. Unbekannte Namen in links werden ignoriert.
func Components(names []string, links []Link) [][]string {
	idx := make(map[string]int, len(names))
	for i, n := range names {
		idx[n] = i
	}
	parent := make([]int, len(names))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for _, l := range links {
		if !l.Bound {
			continue
		}
		a, okA := idx[l.A]
		b, okB := idx[l.B]
		if !okA || !okB {
			continue
		}
		ra, rb := find(a), find(b)
		if ra == rb {
			continue
		}
		if ra < rb {
			parent[rb] = ra
		} else {
			parent[ra] = rb
		}
	}
	var order []int
	groups := map[int][]string{}
	for i, n := range names {
		r := find(i)
		if _, seen := groups[r]; !seen {
			order = append(order, r)
		}
		groups[r] = append(groups[r], n)
	}
	out := make([][]string, 0, len(order))
	for _, r := range order {
		out = append(out, groups[r])
	}
	return out
}

// GroupMember ist eine Rolle eines Verbunds. Fixed: der Host steht bereits fest (I/O-Port-Claim, angepinnte Rolle).
type GroupMember struct {
	Name  string
	Req   PlacementRequest
	Fixed string
}

// GroupResult: gewählter Host je Rolle.
//   - Split: der Verbund läuft auf mehr als einem Host (nur wenn kein einzelner Host ihn unter den Schwellen trägt
//     oder feste Hosts ihn trennen). Cut/CutWeight: die dabei über Host-Grenzen laufenden Verbindungen — sie brauchen einen
//     Netzwerkweg (MXL ist host-lokal).
//   - Overloaded: auch aufgeteilt passt der Verbund nirgends unter die Schwellen; er läuft ungeteilt auf dem am wenigsten
//     belasteten Host.
type GroupResult struct {
	Hosts      map[string]string
	Reason     string
	Split      bool
	Overloaded bool
	Cut        []Link
	CutWeight  float64
}

// searchBudget begrenzt die Suche (Knoten der Tiefensuche); Verbünde sind klein, die Grenze ist nur ein Schutz.
const searchBudget = 400000

type groupCost struct {
	redundancy int     // Mitglieder auf Hosts, die ihre Redundanz-Gruppe schon trägt
	cut        float64 // Gewicht der über Host-Grenzen laufenden Verbindungen
	hosts      int     // belegte Hosts
	mismatch   int     // Mitglieder mit Wunschhost auf einem anderen Host
	noAffinity int     // Mitglieder mit Affinitäts-Gruppe, deren Gruppe nicht auf ihrem Host liegt
	worst      hostScore
	hasWorst   bool
}

// better: a ist besser als b (lexikografisch: Redundanz, Schnitt, Hostzahl, Wunsch, Affinität, geringste Last).
func (a groupCost) better(b groupCost) bool {
	if a.redundancy != b.redundancy {
		return a.redundancy < b.redundancy
	}
	if math.Abs(a.cut-b.cut) > 1e-9 {
		return a.cut < b.cut
	}
	if a.hosts != b.hosts {
		return a.hosts < b.hosts
	}
	if a.mismatch != b.mismatch {
		return a.mismatch < b.mismatch
	}
	if a.noAffinity != b.noAffinity {
		return a.noAffinity < b.noAffinity
	}
	if a.hasWorst && b.hasWorst {
		return lessLoaded(a.worst, b.worst)
	}
	return false
}

// SelectHostGroup platziert einen Verbund. Reihenfolge der Ziele: (1) alles auf einem Host unter den Schwellen,
// (2) sonst die Aufteilung mit dem geringsten Gewicht der über Hosts laufenden Verbindungen, bei der jeder Host unter
// den Schwellen bleibt, (3) sonst ungeteilt auf dem am wenigsten belasteten Host (Overloaded). Innerhalb der Stufe
// zählen Redundanz, weniger Hosts, Wunschhost, Affinität und geringste Last; Gleichstand entscheidet die Hostreihenfolge,
// das Ergebnis ist deterministisch. links: Verbindungen zwischen den Mitgliedern (nur Bound zählt für den Schnitt).
func (e *Engine) SelectHostGroup(members []GroupMember, links []Link, occ Occupancy) GroupResult {
	res := GroupResult{Hosts: map[string]string{}}
	if len(members) == 0 {
		return res
	}
	if len(members) == 1 {
		m := members[0]
		if m.Fixed != "" {
			res.Hosts[m.Name], res.Reason = m.Fixed, "Host fest vorgegeben"
			return res
		}
		r := e.SelectHost(m.Req, occ)
		res.Hosts[m.Name], res.Reason = r.HostID, r.Reason
		return res
	}

	allHosts, err := e.hostLister.ListHosts()
	if err != nil {
		for _, m := range members {
			res.Hosts[m.Name] = ""
		}
		res.Reason = "Host-Liste nicht verfügbar, lokal gestartet"
		return res
	}
	var hostIDs []string
	for _, h := range allHosts {
		if e.hostOnline(h.ID) && !e.IsDraining(h.ID) {
			hostIDs = append(hostIDs, h.ID)
		}
	}
	// feste Hosts zählen immer mit (ohne Kapazitätsprüfung der Zusage, aber mit ihrer Last)
	for _, m := range members {
		if m.Fixed != "" && !containsString(hostIDs, m.Fixed) {
			hostIDs = append(hostIDs, m.Fixed)
		}
	}
	if len(hostIDs) == 0 {
		for _, m := range members {
			res.Hosts[m.Name] = ""
		}
		res.Reason = fmt.Sprintf("Verbund (%s): kein Remote-Host verfügbar, lokal gestartet", memberNames(members))
		return res
	}

	idx := map[string]int{}
	for i, m := range members {
		idx[m.Name] = i
	}
	type edge struct {
		a, b int
		w    float64
		l    Link
	}
	var edges []edge
	adj := make([][]int, len(members))
	for _, l := range links {
		a, okA := idx[l.A]
		b, okB := idx[l.B]
		if !l.Bound || !okA || !okB || a == b {
			continue
		}
		edges = append(edges, edge{a, b, l.weight(), l})
		adj[a] = append(adj[a], b)
		adj[b] = append(adj[b], a)
	}
	// Reihenfolge: zusammenhängend (Breitensuche ab dem ersten Mitglied), damit der Schnitt früh bekannt ist und beschneidet
	order := make([]int, 0, len(members))
	seen := make([]bool, len(members))
	for start := range members {
		if seen[start] {
			continue
		}
		seen[start] = true
		queue := []int{start}
		for len(queue) > 0 {
			c := queue[0]
			queue = queue[1:]
			order = append(order, c)
			for _, n := range adj[c] {
				if !seen[n] {
					seen[n] = true
					queue = append(queue, n)
				}
			}
		}
	}

	nH := len(hostIDs)
	assign := make([]int, len(members))
	for i := range assign {
		assign[i] = -1
	}
	extra := make([]profilesSnapshot, nH)
	for h, id := range hostIDs {
		extra[h] = occ.ExtraLoad[id]
	}
	last := make([]hostScore, nH)
	count := make([]int, nH)
	var best []int
	var bestCost groupCost
	nodes := 0

	redViol := func(m GroupMember, hostID string) bool {
		g := m.Req.RedundancyGroup
		return g != "" && containsString(occ.RedundancyGroupHosts[g], hostID)
	}
	affMiss := func(m GroupMember, hostID string) bool {
		g := m.Req.AffinityGroup
		return g != "" && !containsString(occ.AffinityGroupHosts[g], hostID)
	}
	costOf := func() groupCost {
		var c groupCost
		for i, m := range members {
			hid := hostIDs[assign[i]]
			if redViol(m, hid) {
				c.redundancy++
			}
			if m.Req.PreferredHostID != "" && m.Req.PreferredHostID != hid {
				c.mismatch++
			}
			if affMiss(m, hid) {
				c.noAffinity++
			}
		}
		for _, ed := range edges {
			if assign[ed.a] != assign[ed.b] {
				c.cut += ed.w
			}
		}
		for h := range hostIDs {
			if count[h] == 0 {
				continue
			}
			c.hosts++
			if !c.hasWorst || lessLoaded(c.worst, last[h]) {
				c.worst, c.hasWorst = last[h], true
			}
		}
		return c
	}
	cutSoFar := func(upto int) float64 {
		var c float64
		for _, ed := range edges {
			if assign[ed.a] >= 0 && assign[ed.b] >= 0 && assign[ed.a] != assign[ed.b] {
				c += ed.w
			}
		}
		return c
	}
	var dfs func(pos int)
	dfs = func(pos int) {
		if nodes > searchBudget {
			return
		}
		nodes++
		if best != nil && cutSoFar(pos) > bestCost.cut+1e-9 {
			return
		}
		if pos == len(order) {
			c := costOf()
			if best == nil || c.better(bestCost) {
				best = append([]int(nil), assign...)
				bestCost = c
			}
			return
		}
		mi := order[pos]
		m := members[mi]
		for h := range hostIDs {
			if m.Fixed != "" && hostIDs[h] != m.Fixed {
				continue
			}
			sc := e.scoreHostCredit(hostIDs[h], m.Req.NodeType, extra[h], occ.Credit[hostIDs[h]])
			if !sc.ok && m.Fixed == "" {
				continue
			}
			prevExtra, prevLast := extra[h], last[h]
			if p, has := e.lookupProfile(m.Req.NodeType, hostIDs[h]); has {
				extra[h] = addLoad(extra[h], p)
			}
			last[h] = sc
			count[h]++
			assign[mi] = h
			dfs(pos + 1)
			assign[mi] = -1
			count[h]--
			extra[h], last[h] = prevExtra, prevLast
		}
	}
	dfs(0)

	if best == nil {
		return e.groupOverloaded(members, hostIDs, occ, res)
	}
	used := map[string]bool{}
	for i, m := range members {
		res.Hosts[m.Name] = hostIDs[best[i]]
		used[hostIDs[best[i]]] = true
	}
	res.Split = len(used) > 1
	res.CutWeight = bestCost.cut
	for _, ed := range edges {
		if best[ed.a] != best[ed.b] {
			res.Cut = append(res.Cut, ed.l)
		}
	}
	if !res.Split {
		why := "geringste Last"
		for _, m := range members {
			if m.Req.PreferredHostID != "" && m.Req.PreferredHostID == res.Hosts[m.Name] {
				why = "bevorzugter Host trägt den ganzen Verbund"
				break
			}
		}
		suffix := ""
		if bestCost.redundancy > 0 {
			suffix = " (Redundanz-Konflikt in Kauf genommen)"
		}
		res.Reason = fmt.Sprintf("Verbund (%s) gemeinsam auf einem Host: %s%s", memberNames(members), why, suffix)
		return res
	}
	res.Reason = fmt.Sprintf("Verbund (%s) passt auf keinen einzelnen Host unter den Schwellen und wurde auf %d Hosts aufgeteilt, mit möglichst wenig Verbindungen über Host-Grenzen (%d: %s)",
		memberNames(members), len(used), len(res.Cut), cutNames(res.Cut))
	return res
}

// groupOverloaded: auch aufgeteilt passt der Verbund nirgends — ungeteilt auf den am wenigsten belasteten Host (Wunschhost zuerst).
func (e *Engine) groupOverloaded(members []GroupMember, hostIDs []string, occ Occupancy, res GroupResult) GroupResult {
	type cand struct {
		id    string
		score hostScore
	}
	var cands []cand
	for _, id := range hostIDs {
		extra := occ.ExtraLoad[id]
		var last hostScore
		for _, m := range members {
			last = e.scoreHostCredit(id, m.Req.NodeType, extra, occ.Credit[id])
			if p, has := e.lookupProfile(m.Req.NodeType, id); has {
				extra = addLoad(extra, p)
			}
		}
		cands = append(cands, cand{id, last})
	}
	chosen := 0
	pref := ""
	for _, m := range members {
		if m.Req.PreferredHostID != "" && containsString(hostIDs, m.Req.PreferredHostID) {
			pref = m.Req.PreferredHostID
			break
		}
	}
	if pref != "" {
		for i, c := range cands {
			if c.id == pref {
				chosen = i
			}
		}
	} else {
		for i := 1; i < len(cands); i++ {
			if lessLoaded(cands[i].score, cands[chosen].score) {
				chosen = i
			}
		}
	}
	for _, m := range members {
		res.Hosts[m.Name] = cands[chosen].id
	}
	res.Overloaded = true
	res.Reason = fmt.Sprintf("Verbund (%s) gemeinsam auf einem Host: kein Host trägt ihn unter den Schwellen, auch aufgeteilt nicht — Überlast in Kauf genommen", memberNames(members))
	return res
}

func cutNames(ls []Link) string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = l.A + "→" + l.B
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

type profilesSnapshot = profiles.Snapshot

func addLoad(a, b profiles.Snapshot) profiles.Snapshot {
	a.CPUAvg += b.CPUAvg
	a.RSSAvg += b.RSSAvg
	return a
}

func memberNames(ms []GroupMember) string {
	n := make([]string, len(ms))
	for i, m := range ms {
		n[i] = m.Name
	}
	sort.Strings(n)
	return strings.Join(n, ", ")
}

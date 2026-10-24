// Netzwerkarme Platzierung (ARCHITECTURE.md §31, UMSETZUNG.md Kapitel 56):
// Rollen, die über MXL verbunden sind, bilden einen Verbund und werden als
// Einheit auf EINEM Host platziert — MXL ist host-lokal, ein Verbund über
// mehrere Hosts hätte keinen Signalweg. Verbindungen über Netzwerk-Gateways
// binden nicht hart, bevorzugen aber denselben Host (weniger Querverkehr).
// Kein Lernverfahren: deterministische Filter + Lastvergleich wie SelectHost.
package placement

import (
	"fmt"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// Link verbindet zwei Rollen eines Starts. Bound=true: MXL (beide Enden müssen auf einen Host),
// false: Netzwerkweg (nur Vorliebe für denselben Host).
type Link struct {
	A, B  string
	Bound bool
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

// GroupResult: gewählter Host je Rolle. Split=true: der Verbund passt auf keinen einzelnen Host
// (oder hat zwei feste Hosts) — MXL-Verbindungen zwischen den Hosts funktionieren dann nicht.
type GroupResult struct {
	Hosts  map[string]string
	Reason string
	Split  bool
}

// SelectHostGroup wählt einen gemeinsamen Host für alle Mitglieder: Kandidat ist, wer online ist, nicht gesperrt
// und die Summe aller Mitglieder (Profil + Zusatzlast) unter den Schwellen trägt. Danach Redundanz (mit Rückfall),
// Vorliebe eines Mitglieds, Affinität, geringste Last (wie SelectHost). Passt kein Host: Aufteilung mit Hinweis.
func (e *Engine) SelectHostGroup(members []GroupMember, occ Occupancy) GroupResult {
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

	// Feste Hosts: der erste gilt für den ganzen Verbund; weitere, andere sind eine Aufteilung.
	fixedHost, hasFixed := "", false
	for _, m := range members {
		if m.Fixed == "" {
			continue
		}
		if !hasFixed {
			fixedHost, hasFixed = m.Fixed, true
		} else if m.Fixed != fixedHost {
			res.Split = true
		}
	}
	if hasFixed {
		for _, m := range members {
			if m.Fixed != "" {
				res.Hosts[m.Name] = m.Fixed
			} else {
				res.Hosts[m.Name] = fixedHost
			}
		}
		res.Reason = fmt.Sprintf("Verbund an festen Host gebunden (%s)", memberNames(members))
		if res.Split {
			res.Reason = fmt.Sprintf("Verbund hat verschiedene feste Hosts (%s) — MXL-Verbindungen zwischen ihnen funktionieren nicht", memberNames(members))
		}
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

	type cand struct {
		hostID     string
		score      hostScore
		affinity   bool
		redundancy bool
	}
	var cands []cand
	for _, h := range allHosts {
		if !e.hostOnline(h.ID) || e.IsDraining(h.ID) {
			continue
		}
		extra := occ.ExtraLoad[h.ID]
		ok := true
		var last hostScore
		for _, m := range members {
			s := e.scoreHost(h.ID, m.Req.NodeType, extra)
			if !s.ok {
				ok = false
				break
			}
			last = s
			if p, has := e.lookupProfile(m.Req.NodeType, h.ID); has {
				extra = addLoad(extra, p)
			}
		}
		if !ok {
			continue
		}
		c := cand{hostID: h.ID, score: last}
		for _, m := range members {
			if g := m.Req.AffinityGroup; g != "" && containsString(occ.AffinityGroupHosts[g], h.ID) {
				c.affinity = true
			}
			if g := m.Req.RedundancyGroup; g != "" && containsString(occ.RedundancyGroupHosts[g], h.ID) {
				c.redundancy = true
			}
		}
		cands = append(cands, c)
	}

	if len(cands) > 0 {
		pool := make([]cand, 0, len(cands))
		for _, c := range cands {
			if !c.redundancy {
				pool = append(pool, c)
			}
		}
		suffix := ""
		if len(pool) == 0 {
			pool = cands
			suffix = " (Redundanz-Konflikt in Kauf genommen)"
		}
		chosen := -1
		why := "geringste Last"
		for _, m := range members {
			if m.Req.PreferredHostID == "" {
				continue
			}
			for i, c := range pool {
				if c.hostID == m.Req.PreferredHostID {
					chosen, why = i, "bevorzugter Host trägt den ganzen Verbund"
					break
				}
			}
			if chosen >= 0 {
				break
			}
		}
		if chosen < 0 {
			var aff []int
			for i, c := range pool {
				if c.affinity {
					aff = append(aff, i)
				}
			}
			scan := make([]int, 0, len(pool))
			if len(aff) > 0 {
				scan, why = aff, "Affinitäts-Gruppe bereits auf diesem Host"
			} else {
				for i := range pool {
					scan = append(scan, i)
				}
			}
			chosen = scan[0]
			for _, i := range scan[1:] {
				if lessLoaded(pool[i].score, pool[chosen].score) {
					chosen = i
				}
			}
		}
		for _, m := range members {
			res.Hosts[m.Name] = pool[chosen].hostID
		}
		res.Reason = fmt.Sprintf("Verbund (%s) gemeinsam auf einem Host: %s%s", memberNames(members), why, suffix)
		return res
	}

	// Kein einzelner Host trägt den Verbund: nacheinander platzieren, dabei am zuerst gewählten Host festhalten, wenn er noch passt.
	extra := map[string]profilesSnapshot{}
	anchor := ""
	distinct := map[string]bool{}
	for _, m := range members {
		o := occ
		o.ExtraLoad = map[string]profilesSnapshot{}
		for k, v := range occ.ExtraLoad {
			o.ExtraLoad[k] = v
		}
		for k, v := range extra {
			o.ExtraLoad[k] = addLoad(o.ExtraLoad[k], v)
		}
		req := m.Req
		if req.PreferredHostID == "" {
			req.PreferredHostID = anchor
		}
		r := e.SelectHost(req, o)
		res.Hosts[m.Name] = r.HostID
		distinct[r.HostID] = true
		if anchor == "" {
			anchor = r.HostID
		}
		if p, has := e.lookupProfile(m.Req.NodeType, r.HostID); has {
			extra[r.HostID] = addLoad(extra[r.HostID], p)
		}
	}
	if len(distinct) > 1 {
		res.Split = true
		res.Reason = fmt.Sprintf("Verbund (%s) passt auf keinen einzelnen Host und wurde aufgeteilt — MXL-Verbindungen zwischen den Hosts funktionieren nicht", memberNames(members))
	} else {
		res.Reason = fmt.Sprintf("Verbund (%s) auf einem Host (Rückfall)", memberNames(members))
	}
	return res
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

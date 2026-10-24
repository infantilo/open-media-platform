// Netzwerkarme Platzierung für Workflows (ARCHITECTURE.md §31, UMSETZUNG.md Kapitel 56): MXL-verbundene Rollen
// werden als Verbund auf einem Host platziert (placement.SelectHostGroup), Rollen mit Netzwerk-Verbindung
// bevorzugen den Host ihrer Gegenstelle. Start, Vorschau und Neustart einer Rolle nutzen dieselbe Logik.
package workflows

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
)

var _ groupSelector = (*placement.Engine)(nil)

// groupSelector ist die optionale Verbund-Platzierung der Engine (Test-Doubles ohne sie fallen auf Einzelplatzierung zurück).
type groupSelector interface {
	SelectHostGroup(members []placement.GroupMember, occ placement.Occupancy) placement.GroupResult
}

// roleLinks leitet aus den Verbindungen der Definition die Platzierungs-Links ab: Verbindungen über Gateway-Typen
// (Katalog-Feld `network`) laufen über das Netz und binden nicht hart, alle anderen sind MXL und binden.
// Standby-Rollen tauchen nicht in Verbindungen auf und bleiben daher einzeln.
func roleLinks(def Definition, catalog []launcher.CatalogEntry) []placement.Link {
	typeOf := map[string]string{}
	for _, r := range def.Roles {
		typeOf[r.Name] = r.NodeType
	}
	gateway := map[string]bool{}
	for _, e := range catalog {
		if e.Network != nil {
			gateway[e.Type] = true
		}
	}
	seen := map[[2]string]bool{}
	var out []placement.Link
	for _, c := range def.Connections {
		if c.FromRole == c.ToRole || typeOf[c.FromRole] == "" || typeOf[c.ToRole] == "" {
			continue
		}
		bound := !gateway[typeOf[c.FromRole]] && !gateway[typeOf[c.ToRole]]
		k := [2]string{c.FromRole, c.ToRole}
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, placement.Link{A: c.FromRole, B: c.ToRole, Bound: bound})
	}
	return out
}

// startPlacer platziert die Rollen eines Starts bzw. einer Vorschau: Verbünde vorab als Einheit, Einzelrollen der Reihe nach.
type startPlacer struct {
	s      *Service
	links  []placement.Link
	group  map[string]placement.PlacementResult // Rolle -> Ergebnis, nur für Rollen in Verbünden mit mehreren Mitgliedern
	placed map[string]string                    // Rolle -> bereits gewählter Host
}

// newStartPlacer rechnet die Verbünde (≥ 2 Mitglieder) im Voraus. fixed: Rolle -> Host, der schon feststeht (I/O-Port-Claim).
func (s *Service) newStartPlacer(def Definition, fixed map[string]string, occ placement.Occupancy) *startPlacer {
	p := &startPlacer{s: s, links: roleLinks(def, s.catalogEntries()), group: map[string]placement.PlacementResult{}, placed: map[string]string{}}
	gs, ok := s.resources.(groupSelector)
	if !ok || s.resources == nil {
		return p
	}
	names := make([]string, len(def.Roles))
	byName := map[string]Role{}
	for i, r := range def.Roles {
		names[i] = r.Name
		byName[r.Name] = r
	}
	for _, comp := range placement.Components(names, p.links) {
		if len(comp) < 2 {
			continue
		}
		members := make([]placement.GroupMember, 0, len(comp))
		for _, n := range comp {
			r := byName[n]
			m := placement.GroupMember{Name: n, Req: placement.PlacementRequest{
				NodeType: r.NodeType, PreferredHostID: r.HostID, AffinityGroup: r.AffinityGroup, RedundancyGroup: r.RedundancyGroup,
			}}
			if h, ok := fixed[n]; ok {
				m.Fixed = h
			} else if r.HostID != "" && s.launcher != nil && s.roleHostBound(r) {
				m.Fixed = r.HostID
			}
			members = append(members, m)
		}
		res := gs.SelectHostGroup(members, occ)
		for _, n := range comp {
			p.group[n] = placement.PlacementResult{HostID: res.Hosts[n], Reason: res.Reason}
			p.placed[n] = res.Hosts[n]
		}
	}
	return p
}

// record merkt einen von außen festgelegten Host (z. B. I/O-Port-Claim), damit Gegenstellen ihn bevorzugen.
func (p *startPlacer) record(role, host string) { p.placed[role] = host }

// place liefert den Host für role: Verbund-Ergebnis, sonst Einzelplatzierung mit Vorliebe für den Host
// einer bereits platzierten Netzwerk-Gegenstelle (gilt nur, wenn die Rolle selbst keinen Host vorgibt).
func (p *startPlacer) place(role Role, occ placement.Occupancy) placement.PlacementResult {
	if r, ok := p.group[role.Name]; ok {
		return r
	}
	preferred := role.HostID
	if preferred == "" {
		for _, l := range p.links {
			other := ""
			switch role.Name {
			case l.A:
				other = l.B
			case l.B:
				other = l.A
			}
			if h, ok := p.placed[other]; ok && h != "" {
				preferred = h
				break
			}
		}
	}
	res := p.s.resources.SelectHost(placement.PlacementRequest{
		NodeType: role.NodeType, PreferredHostID: preferred, AffinityGroup: role.AffinityGroup, RedundancyGroup: role.RedundancyGroup,
	}, occ)
	p.placed[role.Name] = res.HostID
	return res
}

// peerHost: Host der laufenden, über MXL verbundenen Gegenstellen von role ("" und false, wenn keine oder uneinig).
func peerHost(wf Workflow, links []placement.Link, role string) (string, bool) {
	host, found := "", false
	for _, l := range links {
		if !l.Bound {
			continue
		}
		other := ""
		switch role {
		case l.A:
			other = l.B
		case l.B:
			other = l.A
		default:
			continue
		}
		rt, ok := wf.Runtime[other]
		if !ok || rt.InstanceID == "" {
			continue
		}
		if found && rt.HostID != host {
			return "", false
		}
		host, found = rt.HostID, true
	}
	return host, found
}

// splitMXLLinks liefert die MXL-Verbindungen, deren Enden auf verschiedenen Hosts geplant sind (funktionieren nicht).
func splitMXLLinks(links []placement.Link, hostOf map[string]string) []placement.Link {
	var out []placement.Link
	for _, l := range links {
		a, okA := hostOf[l.A]
		b, okB := hostOf[l.B]
		if l.Bound && okA && okB && a != b {
			out = append(out, l)
		}
	}
	return out
}

func hostsOfRuntime(wf Workflow) map[string]string {
	m := make(map[string]string, len(wf.Runtime))
	for n, rt := range wf.Runtime {
		m[n] = rt.HostID
	}
	return m
}

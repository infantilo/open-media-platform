// Netzwerkarme Platzierung für Workflows (ARCHITECTURE.md §31, UMSETZUNG.md Kapitel 56): MXL-verbundene Rollen
// werden als Verbund auf einem Host platziert (placement.SelectHostGroup), Rollen mit Netzwerk-Verbindung
// bevorzugen den Host ihrer Gegenstelle. Start, Vorschau und Neustart einer Rolle nutzen dieselbe Logik.
package workflows

import (
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

var _ groupSelector = (*placement.Engine)(nil)

// groupSelector ist die optionale Verbund-Platzierung der Engine (Test-Doubles ohne sie fallen auf Einzelplatzierung zurück).
type groupSelector interface {
	SelectHostGroup(members []placement.GroupMember, links []placement.Link, occ placement.Occupancy) placement.GroupResult
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
		res := gs.SelectHostGroup(members, p.links, occ)
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

// splitMXLLinks liefert die direkten MXL-Verbindungen, deren Enden auf verschiedenen Hosts geplant sind. MXL ist
// host-lokal; über eine Host-Grenze läuft es nur mit einem Fabrics/RDMA-Gateway-Paar (omp-fabrics-gateway-initiator/-target).
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

// groupMove: eine Rolle gehört zu einem geplanten Verbund-Umzug (Wartung, Überlast) und zieht auf target. Verbindungen
// zwischen solchen Rollen dürfen Host-Grenzen überqueren (gewollte Aufteilung, mxlPeerConflict ignoriert sie).
type groupMove struct {
	target string
	until  time.Time
}

func groupMoveKey(workflowID, role string) string { return workflowID + "|" + role }

// markGroupMove merkt die geplante Verteilung eines Verbunds für ttl.
func (s *Service) markGroupMove(workflowID string, hosts map[string]string, ttl time.Duration) {
	until := time.Now().Add(ttl)
	for role, host := range hosts {
		s.groupMoves.Store(groupMoveKey(workflowID, role), groupMove{target: host, until: until})
	}
}

func (s *Service) clearGroupMove(workflowID string, roles []string) {
	for _, r := range roles {
		s.groupMoves.Delete(groupMoveKey(workflowID, r))
	}
}

// groupPeerInstances: aktuelle Instanz-IDs der Rollen von wf, die gerade zu einem geplanten Verbund-Umzug gehören.
func (s *Service) groupPeerInstances(wf Workflow) map[string]bool {
	out := map[string]bool{}
	now := time.Now()
	prefix := wf.ID + "|"
	s.groupMoves.Range(func(k, v any) bool {
		key := k.(string)
		if !strings.HasPrefix(key, prefix) {
			return true
		}
		if now.After(v.(groupMove).until) {
			s.groupMoves.Delete(key)
			return true
		}
		if rt, ok := wf.Runtime[strings.TrimPrefix(key, prefix)]; ok && rt.InstanceID != "" {
			out[rt.InstanceID] = true
		}
		return true
	})
	return out
}

// groupMigrationTarget: Zielhost einer überlastungsbedingt umzuziehenden Rolle, die über MXL mit weiteren Rollen
// verbunden ist. Der ganze Verbund wird neu bewertet (SelectHostGroup; die Last der betroffenen Mitglieder auf dem
// Quellhost wird gutgeschrieben, damit ein Verbleib nicht doppelt zählt; Mitglieder auf anderen Hosts bleiben fest).
// Ergebnis ist der geplante Host der Rolle — der Quellhost, wenn der Verbund dort am besten bleibt oder nirgends
// unter die Schwellen passt (kein Umzug in die Überlast). ok=false: kein Verbund, es gilt die Wahl der Platzierung.
func (s *Service) groupMigrationTarget(wf Workflow, role, sourceHostID string) (string, bool) {
	gs, ok := s.resources.(groupSelector)
	if !ok || s.resources == nil {
		return "", false
	}
	links := roleLinks(wf.Definition, s.catalogEntries())
	names := make([]string, len(wf.Definition.Roles))
	byName := map[string]Role{}
	for i, r := range wf.Definition.Roles {
		names[i] = r.Name
		byName[r.Name] = r
	}
	var comp []string
	for _, c := range placement.Components(names, links) {
		for _, n := range c {
			if n == role {
				comp = c
			}
		}
	}
	if len(comp) < 2 {
		return "", false
	}
	occ := s.buildOccupancy(time.Now())
	occ.Credit = map[string]profiles.Snapshot{}
	var members []placement.GroupMember
	for _, n := range comp {
		rt, running := wf.Runtime[n]
		if !running || rt.InstanceID == "" {
			continue
		}
		r := byName[n]
		m := placement.GroupMember{Name: n, Req: placement.PlacementRequest{
			NodeType: r.NodeType, PreferredHostID: rt.HostID, AffinityGroup: r.AffinityGroup, RedundancyGroup: r.RedundancyGroup,
		}}
		if rt.HostID != sourceHostID || (s.launcher != nil && s.roleHostBound(r)) {
			m.Fixed = rt.HostID
		}
		if rt.HostID == sourceHostID {
			c := occ.Credit[sourceHostID]
			p := s.resources.ProjectedLoad(r.NodeType, sourceHostID)
			c.CPUAvg += p.CPUAvg
			c.RSSAvg += p.RSSAvg
			occ.Credit[sourceHostID] = c
		}
		members = append(members, m)
	}
	if len(members) < 2 {
		return "", false
	}
	res := gs.SelectHostGroup(members, links, occ)
	if res.Overloaded {
		return sourceHostID, true
	}
	s.markGroupMove(wf.ID, res.Hosts, 15*time.Minute)
	return res.Hosts[role], true
}

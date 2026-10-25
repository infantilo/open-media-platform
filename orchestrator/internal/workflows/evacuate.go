// Wartungsmodus (internal/maintenance): Host-Evakuierung über das bestehende
// Make-before-break-Protokoll (executeMigration) — eine Rolle nach der anderen,
// damit sich Runtime-Commits und Neuverkabelung innerhalb eines Workflows nicht
// überholen. Pro Rolle wird der Zielhost frisch per SelectHost gewählt (der
// Quellhost ist über die Wartungssperre ausgeschlossen).
package workflows

import (
	"context"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/maintenance"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// RolesOn listet die Rollen laufender Workflows, die auf hostID laufen.
func (s *Service) RolesOn(hostID string) []maintenance.Item {
	all, err := s.store.List()
	if err != nil {
		return nil
	}
	var out []maintenance.Item
	for _, wf := range all {
		if wf.Status != StatusStarted {
			continue
		}
		for _, role := range wf.Definition.Roles {
			rt, ok := wf.Runtime[role.Name]
			if !ok || rt.InstanceID == "" || rt.HostID != hostID {
				continue
			}
			out = append(out, maintenance.Item{Kind: "role", WorkflowID: wf.ID, Role: role.Name, InstanceID: rt.InstanceID, Label: wf.Name + " / " + role.Name})
		}
	}
	return out
}

// EvacuateHost zieht alle Rollen von hostID um (blockierend, s. maintenance.Evacuator).
func (s *Service) EvacuateHost(ctx context.Context, hostID string, onStep func(maintenance.Step)) {
	roles := s.RolesOn(hostID)
	step := maintenance.Step{Total: len(roles)}
	report := func() {
		if onStep != nil {
			onStep(step)
		}
	}
	report()
	fail := func(it maintenance.Item, reason string) {
		it.Reason = reason
		step.Failed = append(step.Failed, it)
		report()
	}

	// Ein nicht erreichbarer Host ist ein Ausfall-, kein Wartungsfall (K7-Failover) — die alte Instanz ließe sich nicht sauber abbauen.
	if est, ok := s.resources.(hostEstimator); ok && !est.EstimateHost(hostID, profiles.Snapshot{}).Online {
		for _, it := range roles {
			fail(it, "Host nicht erreichbar")
		}
		return
	}

	groupCache := map[string]placement.GroupResult{}
	defer func() {
		for key, res := range groupCache {
			wfID := key[:strings.Index(key, "|")]
			for role := range res.Hosts {
				s.groupMoves.Delete(groupMoveKey(wfID, role))
			}
		}
	}()
	for _, it := range roles {
		if ctx.Err() != nil {
			return
		}
		wf, ok := s.stillBacks(it.WorkflowID, it.Role, it.InstanceID)
		if !ok {
			step.Total-- // zwischenzeitlich beendet oder bereits umgezogen
			report()
			continue
		}
		roleDef, ok := roleByName(wf, it.Role)
		if !ok || s.resources == nil {
			fail(it, "kein Placement verfügbar")
			continue
		}
		if s.roleHostBound(roleDef) {
			fail(it, maintenance.ReasonHostBound)
			continue
		}
		targetHost, why := s.evacuationTarget(wf, it, roles, hostID, groupCache)
		if why != "" {
			fail(it, why)
			continue
		}
		res := placement.PlacementResult{HostID: targetHost}
		if !s.claimMigrationAttempt(it.InstanceID) {
			fail(it, "Migration läuft bereits")
			continue
		}
		s.executeMigration(wf.ID, it.Role, it.InstanceID, res.HostID, "maintenance")

		if now, err := s.store.Get(wf.ID); err == nil && now.Runtime[it.Role].InstanceID != it.InstanceID && now.Runtime[it.Role].HostID == res.HostID {
			step.Moved++
			report()
		} else {
			fail(it, "Umzug fehlgeschlagen (alte Instanz läuft unverändert weiter)")
		}
	}
}

// evacuationTarget wählt den Zielhost für eine zu räumende Rolle. Hängt sie über MXL an weiteren Rollen desselben Workflows,
// wird der ganze Verbund neu platziert (ARCHITECTURE.md §31): möglichst alles auf einem Host, sonst so aufgeteilt, dass
// möglichst wenig Verbindungen Host-Grenzen überqueren. Mitglieder auf anderen Hosts bleiben fest. Kein Platz ohne
// Überlast ⇒ der Verbund bleibt stehen (kein Umzug in die Überlast). Zweiter Rückgabewert: Grund, falls es keinen Zielhost gibt.
func (s *Service) evacuationTarget(wf Workflow, it maintenance.Item, onHost []maintenance.Item, hostID string, cache map[string]placement.GroupResult) (string, string) {
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
			if n == it.Role {
				comp = c
			}
		}
	}
	onThisHost := map[string]maintenance.Item{}
	for _, o := range onHost {
		if o.WorkflowID == wf.ID {
			onThisHost[o.Role] = o
		}
	}
	var members []placement.GroupMember
	moving := 0
	for _, n := range comp {
		r := byName[n]
		m := placement.GroupMember{Name: n, Req: placement.PlacementRequest{
			NodeType: r.NodeType, AffinityGroup: r.AffinityGroup, RedundancyGroup: r.RedundancyGroup,
		}}
		if _, here := onThisHost[n]; here {
			moving++
		} else if rt, ok := wf.Runtime[n]; ok && rt.InstanceID != "" {
			m.Fixed = rt.HostID // läuft schon anderswo und bleibt dort
		} else {
			continue
		}
		members = append(members, m)
	}
	if moving < 2 {
		res := s.resources.SelectHost(placement.PlacementRequest{
			NodeType: byName[it.Role].NodeType, AffinityGroup: byName[it.Role].AffinityGroup, RedundancyGroup: byName[it.Role].RedundancyGroup,
		}, s.buildOccupancy(time.Now()))
		if res.HostID == hostID {
			return "", "kein Zielhost verfügbar"
		}
		return res.HostID, ""
	}
	gs, ok := s.resources.(groupSelector)
	if !ok {
		return "", "kein Placement für Verbünde verfügbar"
	}
	key := wf.ID + "|" + comp[0]
	res, cached := cache[key]
	if !cached {
		res = gs.SelectHostGroup(members, links, s.buildOccupancy(time.Now()))
		cache[key] = res
		if !res.Overloaded {
			s.markGroupMove(wf.ID, res.Hosts, 30*time.Minute)
		}
	}
	if res.Overloaded {
		return "", "kein Host hat genug Reserve für den Verbund, auch aufgeteilt nicht (er wird nicht in die Überlast geschoben)"
	}
	target := res.Hosts[it.Role]
	if target == hostID {
		return "", "kein Zielhost verfügbar"
	}
	return target, ""
}

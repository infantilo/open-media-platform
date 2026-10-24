// Wartungsmodus (internal/maintenance): Host-Evakuierung über das bestehende
// Make-before-break-Protokoll (executeMigration) — eine Rolle nach der anderen,
// damit sich Runtime-Commits und Neuverkabelung innerhalb eines Workflows nicht
// überholen. Pro Rolle wird der Zielhost frisch per SelectHost gewählt (der
// Quellhost ist über die Wartungssperre ausgeschlossen).
package workflows

import (
	"context"
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
		for _, it := range roles {
			s.groupMoves.Delete(it.InstanceID)
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

// evacuationTarget wählt den Zielhost für eine zu räumende Rolle. Hängt sie über MXL an weiteren Rollen desselben Workflows
// auf dem zu räumenden Host, zieht der ganze Verbund auf einen gemeinsamen Zielhost (netzwerkarm, ARCHITECTURE.md §31);
// passt er auf keinen, wird er nicht auseinandergerissen. Zweiter Rückgabewert: Grund, falls es keinen Zielhost gibt.
func (s *Service) evacuationTarget(wf Workflow, it maintenance.Item, onHost []maintenance.Item, hostID string, cache map[string]placement.GroupResult) (string, string) {
	names := make([]string, len(wf.Definition.Roles))
	byName := map[string]Role{}
	for i, r := range wf.Definition.Roles {
		names[i] = r.Name
		byName[r.Name] = r
	}
	var comp []string
	for _, c := range placement.Components(names, roleLinks(wf.Definition, s.catalogEntries())) {
		for _, n := range c {
			if n == it.Role {
				comp = c
			}
		}
	}
	var members []placement.GroupMember
	onThisHost := map[string]maintenance.Item{}
	for _, o := range onHost {
		if o.WorkflowID == wf.ID {
			onThisHost[o.Role] = o
		}
	}
	for _, n := range comp {
		if _, ok := onThisHost[n]; !ok {
			continue
		}
		r := byName[n]
		members = append(members, placement.GroupMember{Name: n, Req: placement.PlacementRequest{
			NodeType: r.NodeType, AffinityGroup: r.AffinityGroup, RedundancyGroup: r.RedundancyGroup,
		}})
	}
	if len(members) < 2 {
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
		res = gs.SelectHostGroup(members, s.buildOccupancy(time.Now()))
		cache[key] = res
		if !res.Split {
			for _, m := range members {
				s.groupMoves.Store(onThisHost[m.Name].InstanceID, res.Hosts[m.Name])
			}
		}
	}
	target := res.Hosts[it.Role]
	if res.Split {
		return "", "Verbund passt auf keinen einzelnen Host (MXL-Verbindungen blieben getrennt)"
	}
	if target == hostID {
		return "", "kein Zielhost verfügbar"
	}
	return target, ""
}

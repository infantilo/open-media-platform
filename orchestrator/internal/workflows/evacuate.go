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
		res := s.resources.SelectHost(placement.PlacementRequest{
			NodeType: roleDef.NodeType, AffinityGroup: roleDef.AffinityGroup, RedundancyGroup: roleDef.RedundancyGroup,
		}, s.buildOccupancy(time.Now()))
		if res.HostID == hostID {
			fail(it, "kein Zielhost verfügbar")
			continue
		}
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

// Nachtrag 99 (ARCHITECTURE.md §6.1/§16-Erweiterung "Ressourcen-
// Kapazitätsplanung über die Zeit"): baut die placement.Occupancy für
// EINEN Platzierungsaufruf — welche Affinitäts-/Redundanz-Tags JETZT
// (laufende Workflows) oder DEMNÄCHST (Schedules, die innerhalb
// ForecastWindow fällig werden) welchen Host belegen, plus die daraus
// geschätzte Zusatzlast je Host. §16 beschreibt eine reine, unverbindliche
// Kapazitäts-VORSCHAU (GET /api/v1/capacity) — dieser Code nutzt dieselbe
// Grundidee (Schedules als künftige Ressourcenlast lesen), aber als
// tatsächlichen Eingang für SelectHost, nicht nur als Anzeige.
package workflows

import (
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// ForecastWindow ist die Vorschauzeit für den Scheduler-Forecast — ein
// Host, der JETZT frei aussieht, aber laut Zeitplan innerhalb dieses
// Fensters einen anderen Workflow bekommt, gilt für SelectHost nicht als
// frei. Test-Seam wie tickInterval/fireWindow in scheduler.go (var statt
// const, überschreibbar).
var ForecastWindow = 15 * time.Minute

// buildOccupancy sammelt die Belegung aller ANDEREN Workflows (die
// aufrufende Rolle selbst ist nicht Teil von allWorkflows, s.
// runStart-Aufrufer) — "jetzt" deckt jede Rolle eines laufenden
// Workflows über ihren tatsächlich aufgelösten RoleRuntime.HostID ab,
// "demnächst" bewusst NUR Rollen mit gesetzter HostID-Präferenz
// (dokumentierte Vereinfachung: eine präferenzlose Rolle ließe sich nur
// durch rekursives Platzieren vorhersagen — zirkulär, da ihre eigene
// künftige Platzierung von genau diesem Mechanismus abhinge).
func (s *Service) buildOccupancy(now time.Time) placement.Occupancy {
	occ := placement.Occupancy{
		AffinityGroupHosts:   map[string][]string{},
		RedundancyGroupHosts: map[string][]string{},
		ExtraLoad:            map[string]profiles.Snapshot{},
	}

	all, err := s.store.List()
	if err != nil {
		return occ // best effort — eine leere Occupancy blockiert SelectHost nicht, s. dortige fail-open-Haltung
	}

	for _, wf := range all {
		// Jetzt laufend: über RoleRuntime.HostID, den beim jeweiligen
		// Start tatsächlich aufgelösten Host — nur StatusStarted ist
		// verlässlich "läuft wirklich" (ein "starting"-Workflow löst
		// seine eigenen Geschwister-Rollen separat im runStart-Aufrufer
		// selbst auf, s. dortige Doku).
		if wf.Status == StatusStarted {
			for _, role := range wf.Definition.Roles {
				rt, ok := wf.Runtime[role.Name]
				if !ok {
					continue
				}
				hostID := rt.HostID
				if role.AffinityGroup != "" {
					occ.AffinityGroupHosts[role.AffinityGroup] = append(occ.AffinityGroupHosts[role.AffinityGroup], hostID)
				}
				if role.RedundancyGroup != "" {
					occ.RedundancyGroupHosts[role.RedundancyGroup] = append(occ.RedundancyGroupHosts[role.RedundancyGroup], hostID)
				}
			}
		}

		// Demnächst (Scheduler-Forecast): nur Start-Schedules, nur
		// Rollen mit gesetzter HostID-Präferenz (s. Doku oben).
		for _, sched := range wf.Definition.Schedules {
			if sched.Action != ScheduleActionStart {
				continue
			}
			occAt, ok := occurrenceAt(sched, now)
			if !ok {
				continue
			}
			until := occAt.Sub(now)
			if until < 0 || until >= ForecastWindow {
				continue
			}
			for _, role := range wf.Definition.Roles {
				if role.HostID == "" {
					continue
				}
				if role.AffinityGroup != "" {
					occ.AffinityGroupHosts[role.AffinityGroup] = append(occ.AffinityGroupHosts[role.AffinityGroup], role.HostID)
				}
				if role.RedundancyGroup != "" {
					occ.RedundancyGroupHosts[role.RedundancyGroup] = append(occ.RedundancyGroupHosts[role.RedundancyGroup], role.HostID)
				}
				if s.resources != nil {
					snap := s.resources.ProjectedLoad(role.NodeType, role.HostID)
					existing := occ.ExtraLoad[role.HostID]
					existing.CPUAvg += snap.CPUAvg
					existing.RSSAvg += snap.RSSAvg
					occ.ExtraLoad[role.HostID] = existing
				}
			}
		}
	}

	return occ
}

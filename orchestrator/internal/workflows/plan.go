package workflows

import (
	"fmt"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// Plan-Vorschau eines Workflow-Starts: wo würden die Rollen laufen und mit welchem erwarteten Bedarf, und
// entsteht dabei ein Ressourcenengpass? Rein lesend — startet nichts. Nutzt dieselbe Platzierung
// (SelectHost) wie der echte Start, dazu die gemessenen Profile je Node-Typ und die Telemetrie der Hosts.

// hostEstimator ist die optionale Schätzfunktion der Platzierung (placement.Engine); Fakes ohne sie
// liefern einen Plan ohne Auslastungsangaben.
type hostEstimator interface {
	EstimateHost(hostID string, extra profiles.Snapshot) placement.HostEstimate
}

// RolePlan ist die Vorschau für eine Rolle.
type RolePlan struct {
	Role            string `json:"role"`
	NodeType        string `json:"nodeType"`
	PreferredHostID string `json:"preferredHostId,omitempty"`
	// PlannedHostID: "" = lokal (Orchestrator-Host).
	PlannedHostID    string  `json:"plannedHostId"`
	PlannedHostLabel string  `json:"plannedHostLabel"`
	Fixed            bool    `json:"fixed"` // Host ausdrücklich in der Rolle festgelegt
	Reason           string  `json:"reason,omitempty"`
	CPUPercent       float64 `json:"cpuPercent"` // erwarteter Bedarf in Prozent des Hosts (Profil), 0 = unbekannt
	RAMBytes         uint64  `json:"ramBytes"`
	ProfileKnown     bool    `json:"profileKnown"`
}

// StartPlan ist die Vorschau eines ganzen Workflows.
type StartPlan struct {
	WorkflowID string                   `json:"workflowId"`
	Running    bool                     `json:"running"`
	Roles      []RolePlan               `json:"roles"`
	Hosts      []placement.HostEstimate `json:"hosts"`
	Warnings   []string                 `json:"warnings"`
}

// PlanStart liefert die Plan-Vorschau für Workflow id. Läuft er bereits, zeigt sie die tatsächlichen Hosts.
func (s *Service) PlanStart(id string) (StartPlan, error) {
	wf, err := s.store.Get(id)
	if err != nil {
		return StartPlan{}, err
	}
	return s.planFor(wf), nil
}

// planFor rechnet die Vorschau für einen bereits geladenen Workflow (ohne Zugriff auf den Speicher).
func (s *Service) planFor(wf Workflow) StartPlan {
	plan := StartPlan{WorkflowID: wf.ID, Running: wf.Status == StatusStarted, Roles: []RolePlan{}, Hosts: []placement.HostEstimate{}, Warnings: []string{}}
	occ := s.buildOccupancy(time.Now())
	est, _ := s.resources.(hostEstimator)

	extraByHost := map[string]profiles.Snapshot{}
	order := []string{}
	unknownProfile := map[string]bool{}
	for _, role := range wf.Definition.Roles {
		rp := RolePlan{Role: role.Name, NodeType: role.NodeType, PreferredHostID: role.HostID, Fixed: role.HostID != ""}
		hostID := role.HostID
		switch {
		case plan.Running:
			if rt, ok := wf.Runtime[role.Name]; ok {
				hostID = rt.HostID
				rp.Reason = "läuft"
			}
		case s.resources != nil:
			res := s.resources.SelectHost(placement.PlacementRequest{
				NodeType: role.NodeType, PreferredHostID: role.HostID, AffinityGroup: role.AffinityGroup, RedundancyGroup: role.RedundancyGroup,
			}, occ)
			hostID, rp.Reason = res.HostID, res.Reason
			if role.AffinityGroup != "" {
				occ.AffinityGroupHosts[role.AffinityGroup] = append(occ.AffinityGroupHosts[role.AffinityGroup], hostID)
			}
			if role.RedundancyGroup != "" {
				occ.RedundancyGroupHosts[role.RedundancyGroup] = append(occ.RedundancyGroupHosts[role.RedundancyGroup], hostID)
			}
		}
		rp.PlannedHostID = hostID
		if s.resources != nil {
			prof := s.resources.ProjectedLoad(role.NodeType, hostID)
			rp.CPUPercent, rp.RAMBytes = prof.CPUAvg, prof.RSSAvg
			rp.ProfileKnown = prof.SampleCount > 0 || prof.CPUAvg > 0 || prof.RSSAvg > 0
			if !rp.ProfileKnown {
				unknownProfile[role.NodeType] = true
			}
			if !plan.Running {
				e := extraByHost[hostID]
				e.CPUAvg += prof.CPUAvg
				e.RSSAvg += prof.RSSAvg
				extraByHost[hostID] = e
			}
		}
		if _, seen := extraByHost[hostID]; !seen {
			extraByHost[hostID] = profiles.Snapshot{}
		}
		if !contains(order, hostID) {
			order = append(order, hostID)
		}
		plan.Roles = append(plan.Roles, rp)
	}
	for _, hostID := range order {
		var h placement.HostEstimate
		if est != nil {
			h = est.EstimateHost(hostID, extraByHost[hostID])
		} else {
			h = placement.HostEstimate{HostID: hostID, Label: hostID, Online: true}
		}
		for i := range plan.Roles {
			if plan.Roles[i].PlannedHostID == hostID {
				plan.Roles[i].PlannedHostLabel = h.Label
			}
		}
		plan.Hosts = append(plan.Hosts, h)
		if hostID != "" && !h.Online && est != nil {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("Host „%s“ ist nicht erreichbar", h.Label))
		}
		if !plan.Running && len(h.Over) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("Host „%s“: Engpass beim Start — %s", h.Label, joinStrings(h.Over)))
		}
	}
	types := make([]string, 0, len(unknownProfile))
	for t := range unknownProfile {
		types = append(types, t)
	}
	sort.Strings(types)
	for _, t := range types {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("Für den Node-Typ %s liegt noch kein Messprofil vor — der Bedarf ist unbekannt", t))
	}
	return plan
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func joinStrings(v []string) string {
	out := ""
	for i, s := range v {
		if i > 0 {
			out += " · "
		}
		out += s
	}
	return out
}

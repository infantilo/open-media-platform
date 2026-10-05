package workflows

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

type planResources struct {
	hostFor map[string]string // nodeType -> host
	cpu     map[string]float64
	limit   float64
	base    map[string]float64
}

func (p planResources) CheckHost(string, string) (string, bool) { return "", true }
func (p planResources) SelectHost(req placement.PlacementRequest, _ placement.Occupancy) placement.PlacementResult {
	if req.PreferredHostID != "" {
		return placement.PlacementResult{HostID: req.PreferredHostID, Reason: "bevorzugter Host verfügbar"}
	}
	return placement.PlacementResult{HostID: p.hostFor[req.NodeType], Reason: "Ausweichhost gewählt"}
}
func (p planResources) ProjectedLoad(nodeType, _ string) profiles.Snapshot {
	return profiles.Snapshot{CPUAvg: p.cpu[nodeType], SampleCount: 1}
}
func (p planResources) EstimateHost(hostID string, extra profiles.Snapshot) placement.HostEstimate {
	h := placement.HostEstimate{HostID: hostID, Label: "Host " + hostID, Online: true, HasMetrics: true, CPUNow: p.base[hostID], CPULimit: p.limit}
	h.CPUProjected = h.CPUNow + extra.CPUAvg
	if h.CPUProjected >= h.CPULimit {
		h.Over = []string{"CPU über Grenze"}
	}
	return h
}

func TestPlanStartSumsRoleLoadPerHostAndWarnsAboutBottlenecks(t *testing.T) {
	res := planResources{
		hostFor: map[string]string{"omp-channel-player": "hostA", "omp-video-mixer-me": "hostB"},
		cpu:     map[string]float64{"omp-channel-player": 30, "omp-video-mixer-me": 20},
		limit:   85, base: map[string]float64{"hostA": 40, "hostB": 10},
	}
	svc := NewService(nil, nil, nil, nil, nil, nil, res, nil)
	def := Definition{Roles: []Role{
		{Name: "A", NodeType: "omp-channel-player"},
		{Name: "B", NodeType: "omp-channel-player"},
		{Name: "Mix", NodeType: "omp-video-mixer-me"},
		{Name: "Fest", NodeType: "omp-source", HostID: "hostB"},
	}}
	plan := svc.planFor(Workflow{ID: "w1", Name: "plan-test", Definition: def, Status: StatusStopped})
	if len(plan.Roles) != 4 || plan.Roles[0].PlannedHostID != "hostA" || plan.Roles[2].PlannedHostID != "hostB" {
		t.Fatalf("Rollenplan: %+v", plan.Roles)
	}
	if !plan.Roles[3].Fixed || plan.Roles[3].PlannedHostID != "hostB" {
		t.Fatalf("festgelegter Host muss gelten: %+v", plan.Roles[3])
	}
	// hostA: 40 + 2×30 = 100 ≥ 85 → Engpass; hostB: 10 + 20 + 0 = 30 → ok
	var over []string
	for _, h := range plan.Hosts {
		if len(h.Over) > 0 {
			over = append(over, h.HostID)
		}
	}
	if len(over) != 1 || over[0] != "hostA" {
		t.Fatalf("Engpass nur auf hostA erwartet: %+v", plan.Hosts)
	}
	found := false
	for _, w := range plan.Warnings {
		if containsSub(w, "Engpass") {
			found = true
		}
	}
	if !found {
		t.Fatalf("Warnung zum Engpass fehlt: %v", plan.Warnings)
	}
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

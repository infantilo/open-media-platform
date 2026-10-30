package workflows

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

func TestRoleHostBound(t *testing.T) {
	s := &Service{launcher: &fakeLauncher{catalog: []launcher.CatalogEntry{
		{Type: "omp-capture-card", HostBound: true},
		{Type: "omp-source"},
	}}}
	cases := []struct {
		name string
		role Role
		want bool
	}{
		{"catalog hostBound", Role{NodeType: "omp-capture-card"}, true},
		{"plain role", Role{NodeType: "omp-source"}, false},
		{"escalation pinned", Role{NodeType: "omp-source", Placement: &RolePlacementPolicy{Escalation: EscalationPinned}}, true},
		{"exclusive io port", Role{NodeType: "omp-source", RequiredIOPort: &IOPortRequirement{CardType: "decklink", Direction: "in"}}, true},
		{"auto escalation alone", Role{NodeType: "omp-source", Placement: &RolePlacementPolicy{Escalation: EscalationAuto}}, false},
	}
	for _, c := range cases {
		if got := s.roleHostBound(c.role); got != c.want {
			t.Errorf("%s: roleHostBound = %v, want %v", c.name, got, c.want)
		}
	}
	if err := validate(Definition{Roles: []Role{{Name: "a", NodeType: "omp-source", Placement: &RolePlacementPolicy{Escalation: EscalationPinned}}}}); err != nil {
		t.Errorf("validate rejects pinned escalation: %v", err)
	}
}

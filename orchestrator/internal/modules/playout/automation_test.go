package playout

import (
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

func TestAutomationTargetEnvDerivesTargetsFromRoles(t *testing.T) {
	def := workflows.Definition{Roles: []workflows.Role{
		{Name: "Kanal A", NodeType: "omp-channel-player"},
		{Name: "Kanal B", NodeType: "omp-channel-player"},
		{Name: "Kanal C", NodeType: "omp-channel-player"},
		{Name: "Kanal A Standby", NodeType: "omp-channel-player", StandbyFor: "Kanal A"},
		{Name: "Bildmischer", NodeType: "omp-video-mixer-me"},
		{Name: "Tonmischer", NodeType: "omp-audio-mixer"},
		{Name: "Auto", NodeType: "omp-playout-automation"},
	}}
	env := AutomationTargetEnv(def, def.Roles[6])
	want := map[string]string{
		"OMP_PLAYOUT_TARGET_PLAYER_A_LABEL":    "Kanal A",
		"OMP_PLAYOUT_TARGET_PLAYER_B_LABEL":    "Kanal B",
		"OMP_PLAYOUT_TARGET_MIXER_LABEL":       "Bildmischer",
		"OMP_PLAYOUT_TARGET_AUDIO_MIXER_LABEL": "Tonmischer",
	}
	if len(env) != len(want) {
		t.Fatalf("env = %v", env)
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
	if AutomationTargetEnv(def, def.Roles[0]) != nil {
		t.Error("andere Rollen bekommen keine Ziele")
	}
}

type fakeSvc struct {
	hooks []workflows.RoleEnvHook
	types []string
}

func (f *fakeSvc) RegisterRoleEnvHook(h workflows.RoleEnvHook) { f.hooks = append(f.hooks, h) }
func (f *fakeSvc) RegisterControlPlaneType(t string)           { f.types = append(f.types, t) }

func TestRegisterAnnouncesHookAndControlPlaneType(t *testing.T) {
	f := &fakeSvc{}
	Register(f)
	if len(f.hooks) != 1 || len(f.types) != 1 || f.types[0] != "omp-playout-automation" {
		t.Fatalf("%+v", f)
	}
}

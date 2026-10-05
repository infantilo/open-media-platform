package workflows

import "testing"

func TestAutomationTargetEnvDerivesTargetsFromRoles(t *testing.T) {
	def := Definition{Roles: []Role{
		{Name: "Kanal A", NodeType: "omp-channel-player"},
		{Name: "Kanal B", NodeType: "omp-channel-player"},
		{Name: "Kanal C", NodeType: "omp-channel-player"},
		{Name: "Kanal A Standby", NodeType: "omp-channel-player", StandbyFor: "Kanal A"},
		{Name: "Bildmischer", NodeType: "omp-video-mixer-me"},
		{Name: "Tonmischer", NodeType: "omp-audio-mixer"},
		{Name: "Auto", NodeType: "omp-playout-automation"},
	}}
	env := automationTargetEnv(def, def.Roles[6])
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
	if automationTargetEnv(def, def.Roles[0]) != nil {
		t.Error("andere Rollen bekommen keine Ziele")
	}
}

func TestWithAutomationTargetsKeepsExplicitValuesAndDoesNotMutate(t *testing.T) {
	def := Definition{Roles: []Role{{Name: "A", NodeType: "omp-channel-player"}, {Name: "Auto", NodeType: "omp-playout-automation"}}}
	base := map[string]string{"OMP_PLAYOUT_TARGET_PLAYER_A_LABEL": "von Hand", "X": "1"}
	got := withAutomationTargets(base, def, def.Roles[1])
	if got["OMP_PLAYOUT_TARGET_PLAYER_A_LABEL"] != "von Hand" || got["X"] != "1" {
		t.Fatalf("explizite Werte müssen gewinnen: %v", got)
	}
	if len(base) != 2 {
		t.Fatalf("base wurde verändert: %v", base)
	}
	if out := withAutomationTargets(base, Definition{}, Role{NodeType: "omp-source"}); len(out) != 2 {
		t.Fatalf("Nicht-Automation: unverändert erwartet")
	}
}

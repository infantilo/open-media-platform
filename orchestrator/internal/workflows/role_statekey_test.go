package workflows

import (
	"regexp"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

func TestRoleStateKeyStableAndFileSafe(t *testing.T) {
	a := roleStateKey("wf-1", "Handy")
	if a != roleStateKey("wf-1", "Handy") {
		t.Fatal("Schlüssel nicht stabil")
	}
	if a == roleStateKey("wf-1", "Anderes") || a == roleStateKey("wf-2", "Handy") {
		t.Fatal("Schlüssel kollidieren")
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(a) {
		t.Fatalf("kein Dateiname-tauglicher Hex-Schlüssel: %q", a)
	}
}

func TestRoleEnvCarriesStateKeyOnStartRestartAndMigration(t *testing.T) {
	base := map[string]string{"X": "1"}
	want := roleStateKey("wf-1", "Handy")
	for name, env := range map[string]map[string]string{
		"Start/Neustart (withRoleSeed)": withRoleSeed(base, "wf-1", "Handy"),
		"Migration (withRoleStateKey)":  withRoleStateKey(base, "wf-1", "Handy"),
	} {
		if env[launcher.StateKeyEnv] != want || env["X"] != "1" {
			t.Fatalf("%s: env = %v", name, env)
		}
	}
	if _, ok := base[launcher.StateKeyEnv]; ok {
		t.Fatal("Eingabe-Map verändert")
	}
}

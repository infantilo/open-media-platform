package workflows

import "testing"

func TestRoleEnvIsMergedAndValidatedAgainstTheAllowlist(t *testing.T) {
	role := Role{Name: "Kanal-Player A", NodeType: "omp-channel-player", Env: map[string]string{"OMP_DEINTERLACE_METHOD": "linear"}}
	base := map[string]string{"OMP_WIDTH": "1280"}
	got := roleExtraEnv(base, role)
	if got["OMP_DEINTERLACE_METHOD"] != "linear" || got["OMP_WIDTH"] != "1280" {
		t.Fatalf("env = %v", got)
	}
	if len(base) != 1 {
		t.Fatalf("base wurde verändert: %v", base)
	}
	if err := validateRoleEnv(role); err != nil {
		t.Fatal(err)
	}
	if validateRoleEnv(Role{Name: "x", Env: map[string]string{"LD_PRELOAD": "/x.so"}}) == nil {
		t.Error("unbekannter Schlüssel muss abgelehnt werden")
	}
	if validateRoleEnv(Role{Name: "x", Env: map[string]string{"OMP_DEINTERLACE_METHOD": "rm -rf"}}) == nil {
		t.Error("ungültiger Wert muss abgelehnt werden")
	}
	if err := validate(Definition{Roles: []Role{{Name: "x", NodeType: "omp-source", Env: map[string]string{"FOO": "1"}}}}); err == nil {
		t.Error("validate muss unbekannte Env-Schlüssel ablehnen")
	}
}

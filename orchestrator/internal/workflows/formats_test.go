package workflows

import "testing"

// Kapitel 39: Werte für den Playout-Puffer dürfen als Role.Env gesetzt werden, ein unbekannter Haltebild-Modus nicht.
func TestValidateRoleEnvPlayoutBuffer(t *testing.T) {
	ok := Role{Name: "out", NodeType: "omp-playout-buffer", Env: map[string]string{"OMP_BUFFER_MS": "2500", "OMP_HOLD_MODE": "black", "OMP_RESUME_MS": "800"}}
	if err := validateRoleEnv(ok); err != nil {
		t.Fatalf("validateRoleEnv(%v) = %v, want nil", ok.Env, err)
	}
	bad := Role{Name: "out", NodeType: "omp-playout-buffer", Env: map[string]string{"OMP_HOLD_MODE": "blue"}}
	if err := validateRoleEnv(bad); err == nil {
		t.Fatal("OMP_HOLD_MODE=blue muss abgelehnt werden")
	}
}

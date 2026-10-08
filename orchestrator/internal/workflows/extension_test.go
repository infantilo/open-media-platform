package workflows

import "testing"

func TestRoleEnvHooksMergeWithExplicitValuesWinningAndNoMutation(t *testing.T) {
	s := &Service{}
	s.RegisterRoleEnvHook(func(def Definition, role Role) map[string]string {
		if role.NodeType != "x" {
			return nil
		}
		return map[string]string{"A": "hook1", "B": "hook1"}
	})
	s.RegisterRoleEnvHook(func(def Definition, role Role) map[string]string {
		return map[string]string{"B": "hook2", "C": "hook2"}
	})
	base := map[string]string{"A": "explizit", "X": "1"}
	got := s.withRoleHooks(base, Definition{}, Role{NodeType: "x"})
	want := map[string]string{"A": "explizit", "B": "hook1", "C": "hook2", "X": "1"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (%v)", k, got[k], v, got)
		}
	}
	if len(base) != 2 || base["A"] != "explizit" {
		t.Fatalf("base wurde verändert: %v", base)
	}
	// Ohne Hook-Beitrag: dieselbe Map zurück, keine Kopie.
	only := map[string]string{"Z": "1"}
	if out := (&Service{}).withRoleHooks(only, Definition{}, Role{}); len(out) != 1 || out["Z"] != "1" {
		t.Fatal("ohne Hooks muss base unverändert bleiben")
	}
}

func TestControlPlaneTypesAreRegisteredNotHardcoded(t *testing.T) {
	s := &Service{}
	if s.IsControlPlaneNodeType("omp-playout-automation") {
		t.Fatal("der Kern darf keinen Node-Typ von sich aus als Control-Plane kennen")
	}
	s.RegisterControlPlaneType("omp-playout-automation")
	if !s.IsControlPlaneNodeType("omp-playout-automation") || s.IsControlPlaneNodeType("omp-source") {
		t.Fatal("registrierter Typ muss gelten, andere nicht")
	}
}

package launcher

import "testing"

func TestWithStateKeyFirstStartUsesID(t *testing.T) {
	in := map[string]string{"A": "1"}
	out := withStateKey(in, "id-1", "")
	if out[StateKeyEnv] != "id-1" || out["A"] != "1" {
		t.Fatalf("out = %v", out)
	}
	if _, ok := in[StateKeyEnv]; ok {
		t.Fatal("Eingabe-Map verändert")
	}
}

func TestWithStateKeyRestartKeepsInheritedKey(t *testing.T) {
	first := withStateKey(nil, "id-1", "")
	second := withStateKey(first, "id-2", "id-1") // Neustart: neue ID, ExtraEnv der alten Instanz
	if second[StateKeyEnv] != "id-1" {
		t.Fatalf("Schlüssel nicht geerbt: %v", second)
	}
	if third := withStateKey(second, "id-3", "id-2"); third[StateKeyEnv] != "id-1" {
		t.Fatalf("zweiter Neustart: %v", third)
	}
}

func TestWithStateKeyLegacyInstanceUsesPredecessorID(t *testing.T) {
	// Instanz aus der Zeit vor dem Schlüssel: ExtraEnv ohne Schlüssel, Node legte den Zustand unter seiner ID ab.
	out := withStateKey(map[string]string{"A": "1"}, "neu", "alt")
	if out[StateKeyEnv] != "alt" {
		t.Fatalf("out = %v", out)
	}
}

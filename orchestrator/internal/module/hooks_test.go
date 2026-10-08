package module

import "testing"

func TestMethodObserversMatchByNameAndSurvivePanics(t *testing.T) {
	h := NewHooks()
	var got []string
	h.OnNodeMethod([]string{"take", "next"}, func(c MethodCall) { got = append(got, "a:"+c.Name) })
	h.OnNodeMethod([]string{"take"}, func(c MethodCall) { panic("kaputt") })
	h.OnNodeMethod([]string{"take"}, func(c MethodCall) { got = append(got, "c:"+c.Name) })
	if !h.WantsMethod("take") || !h.WantsMethod("next") || h.WantsMethod("other") {
		t.Fatal("WantsMethod")
	}
	h.NotifyMethod(MethodCall{Name: "take"})
	h.NotifyMethod(MethodCall{Name: "next"})
	h.NotifyMethod(MethodCall{Name: "other"})
	want := []string{"a:take", "c:take", "a:next"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v, want %v (a panicking observer must not stop the others)", got, want)
		}
	}
}

func TestNilHooksAreInert(t *testing.T) {
	var h *Hooks
	if h.WantsMethod("x") {
		t.Fatal("nil hooks want nothing")
	}
	h.NotifyMethod(MethodCall{Name: "x"}) // darf nicht panicken
}

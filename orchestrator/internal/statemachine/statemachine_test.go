package statemachine

import "testing"

func TestAllowedAndValidate(t *testing.T) {
	m := New([][2]string{
		{"draft", "published"},
		{"published", "archived"},
	})

	if !m.Allowed("draft", "published") {
		t.Errorf("Allowed(draft, published) = false, want true")
	}
	if m.Allowed("draft", "archived") {
		t.Errorf("Allowed(draft, archived) = true, want false (no direct edge)")
	}
	if m.Allowed("archived", "draft") {
		t.Errorf("Allowed(archived, draft) = true, want false (no edge at all)")
	}

	if err := m.Validate("draft", "published"); err != nil {
		t.Errorf("Validate(draft, published) error = %v, want nil", err)
	}
	if err := m.Validate("draft", "archived"); err == nil {
		t.Errorf("Validate(draft, archived) error = nil, want ErrInvalidTransition")
	}
}

func TestIsTerminal(t *testing.T) {
	m := New([][2]string{
		{"a", "b"},
		{"b", "c"},
	})
	if m.IsTerminal("a") {
		t.Errorf("IsTerminal(a) = true, want false")
	}
	if !m.IsTerminal("c") {
		t.Errorf("IsTerminal(c) = false, want true")
	}
	if !m.IsTerminal("unknown") {
		t.Errorf("IsTerminal(unknown) = false, want true (no outgoing edges)")
	}
}

func TestSameStateNotImplicitlyAllowed(t *testing.T) {
	m := New([][2]string{{"a", "b"}})
	if m.Allowed("a", "a") {
		t.Errorf("Allowed(a, a) = true, want false — self-loops must be listed explicitly, not assumed")
	}
}

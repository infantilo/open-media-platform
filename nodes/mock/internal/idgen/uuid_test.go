package idgen

import (
	"regexp"
	"testing"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNewV4MatchesIS04Pattern(t *testing.T) {
	for i := 0; i < 100; i++ {
		id := NewV4()
		if !uuidPattern.MatchString(id) {
			t.Fatalf("NewV4() = %q, does not match IS-04 id pattern", id)
		}
	}
}

func TestNewV4IsUnique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := NewV4()
		if seen[id] {
			t.Fatalf("duplicate UUID generated: %s", id)
		}
		seen[id] = true
	}
}

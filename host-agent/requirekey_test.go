package main

import "testing"

func TestRequireCommandKeyDefaultsToOn(t *testing.T) {
	for value, want := range map[string]bool{"": true, "1": true, "true": true, "quatsch": true, "false": false, "0": false} {
		if got := requireCommandKey(value); got != want {
			t.Errorf("requireCommandKey(%q) = %v, want %v", value, got, want)
		}
	}
}

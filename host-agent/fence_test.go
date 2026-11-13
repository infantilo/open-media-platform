package main

import (
	"testing"
	"time"
)

func TestFenceAfterFromEnv(t *testing.T) {
	cases := map[string]time.Duration{"": 0, "0": 0, "10s": 0, "unsinn": 0, "30s": 30 * time.Second, "2m": 2 * time.Minute}
	for in, want := range cases {
		if got := fenceAfterFromEnv(in); got != want {
			t.Errorf("fenceAfterFromEnv(%q) = %v, want %v", in, got, want)
		}
	}
}

package safego

import (
	"testing"
	"time"
)

func TestGoRunsFnNormally(t *testing.T) {
	done := make(chan struct{})
	Go("test.normal", func() {
		close(done)
	})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("fn did not run within 1s")
	}
}

func TestGoRecoversPanicWithoutCrashingProcess(t *testing.T) {
	done := make(chan struct{})
	Go("test.panics", func() {
		defer close(done)
		panic("boom")
	})
	select {
	case <-done:
		// Reaching here (instead of the test binary crashing) already
		// proves the panic was recovered — s. Package-Doku.
	case <-time.After(time.Second):
		t.Fatal("fn did not run within 1s")
	}
}

func TestGoRunsSubsequentGoroutinesAfterAPanic(t *testing.T) {
	Go("test.panics-first", func() {
		panic("boom")
	})

	done := make(chan struct{})
	Go("test.normal-after", func() {
		close(done)
	})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("second goroutine did not run within 1s")
	}
}

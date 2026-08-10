package auth

import (
	"testing"
	"time"
)

func TestLoginLockoutAllowsUpToMaxFailures(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }

	for i := 0; i < maxLoginFailures-1; i++ {
		l.RecordFailure("alice")
	}
	if l.Locked("alice") {
		t.Fatalf("locked after %d failures, want unlocked (max=%d)", maxLoginFailures-1, maxLoginFailures)
	}
}

func TestLoginLockoutLocksAtMaxFailures(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }

	for i := 0; i < maxLoginFailures; i++ {
		l.RecordFailure("alice")
	}
	if !l.Locked("alice") {
		t.Fatalf("not locked after %d failures", maxLoginFailures)
	}
}

func TestLoginLockoutUnlocksAfterLockoutDuration(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }
	for i := 0; i < maxLoginFailures; i++ {
		l.RecordFailure("alice")
	}
	l.now = func() time.Time { return base.Add(loginLockoutDuration + time.Second) }
	if l.Locked("alice") {
		t.Fatalf("still locked after lockoutDuration elapsed")
	}
}

func TestLoginLockoutOldFailuresOutsideWindowDoNotAccumulate(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }
	for i := 0; i < maxLoginFailures-1; i++ {
		l.RecordFailure("alice")
	}
	// Fenster abgelaufen: der nächste Fehlversuch startet ein neues
	// Fenster mit Zähler 1, statt den alten Stand fortzuführen.
	l.now = func() time.Time { return base.Add(loginFailureWindow + time.Second) }
	l.RecordFailure("alice")
	if l.Locked("alice") {
		t.Fatalf("locked after window reset, want a fresh count of 1")
	}
}

func TestLoginLockoutRecordSuccessClearsFailures(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }
	for i := 0; i < maxLoginFailures-1; i++ {
		l.RecordFailure("alice")
	}
	l.RecordSuccess("alice")
	l.RecordFailure("alice")
	if l.Locked("alice") {
		t.Fatalf("locked after a single failure post-success, want the counter reset by RecordSuccess")
	}
}

func TestLoginLockoutIsPerUsername(t *testing.T) {
	l := NewLoginLockout()
	base := time.Now()
	l.now = func() time.Time { return base }
	for i := 0; i < maxLoginFailures; i++ {
		l.RecordFailure("alice")
	}
	if l.Locked("bob") {
		t.Fatalf("locking alice must not lock bob")
	}
}

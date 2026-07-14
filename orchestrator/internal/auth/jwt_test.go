package auth

import (
	"strings"
	"testing"
	"time"
)

func TestSignerIssueAndVerifyRoundTrip(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	now := time.Now()
	token, exp, err := signer.issue(Principal{UserID: "u1", Username: "alice"}, now)
	if err != nil {
		t.Fatalf("issue() error = %v", err)
	}
	if !exp.Equal(now.Add(TokenTTL)) {
		t.Errorf("exp = %v, want %v", exp, now.Add(TokenTTL))
	}
	if strings.Count(token, ".") != 2 {
		t.Fatalf("token = %q, want 3 dot-separated parts", token)
	}

	got, err := signer.verify(token, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("verify() error = %v", err)
	}
	if got.UserID != "u1" || got.Username != "alice" {
		t.Errorf("verify() = %+v, want UserID=u1 Username=alice", got)
	}
}

func TestSignerVerifyRejectsExpiredToken(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	now := time.Now()
	token, _, err := signer.issue(Principal{UserID: "u1", Username: "alice"}, now)
	if err != nil {
		t.Fatalf("issue() error = %v", err)
	}

	_, err = signer.verify(token, now.Add(TokenTTL+time.Minute))
	if err != ErrTokenExpired {
		t.Errorf("verify() error = %v, want ErrTokenExpired", err)
	}
}

func TestSignerVerifyRejectsWrongSecret(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	other := NewSigner([]byte("other-secret"))
	now := time.Now()
	token, _, err := signer.issue(Principal{UserID: "u1", Username: "alice"}, now)
	if err != nil {
		t.Fatalf("issue() error = %v", err)
	}

	_, err = other.verify(token, now)
	if err != ErrTokenInvalid {
		t.Errorf("verify() error = %v, want ErrTokenInvalid", err)
	}
}

func TestSignerVerifyRejectsTamperedPayload(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	now := time.Now()
	token, _, err := signer.issue(Principal{UserID: "u1", Username: "alice"}, now)
	if err != nil {
		t.Fatalf("issue() error = %v", err)
	}
	parts := strings.Split(token, ".")
	tampered := parts[0] + ".dGFtcGVyZWQ." + parts[2]

	_, err = signer.verify(tampered, now)
	if err != ErrTokenInvalid {
		t.Errorf("verify() error = %v, want ErrTokenInvalid", err)
	}
}

func TestSignerVerifyRejectsMalformedToken(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	if _, err := signer.verify("not-a-token", time.Now()); err != ErrTokenInvalid {
		t.Errorf("verify() error = %v, want ErrTokenInvalid", err)
	}
}

func TestHashPasswordAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("s3cr3t")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if hash == "s3cr3t" {
		t.Fatalf("HashPassword() returned plaintext")
	}
	if !VerifyPassword(hash, "s3cr3t") {
		t.Errorf("VerifyPassword() = false, want true for correct password")
	}
	if VerifyPassword(hash, "wrong") {
		t.Errorf("VerifyPassword() = true, want false for wrong password")
	}
}

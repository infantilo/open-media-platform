package auth

import (
	"context"
	"testing"
	"time"
)

// newTestService baut einen Service gegen die echte (dbtest-isolierte)
// Postgres, s. testDB in store_test.go.
func newTestService(t *testing.T) *Service {
	t.Helper()
	database := testDB(t)
	return NewService(NewStore(database), []byte("test-secret"))
}

func TestServiceAuthenticateAcceptsFreshToken(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()
	username := "test-svc-fresh-" + mustNewID(t)
	t.Cleanup(func() { _ = svc.DeleteUser(ctx, username) })

	if _, err := svc.CreateUser(ctx, username, "supersecret1"); err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	token, _, err := svc.Login(ctx, username, "supersecret1")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}

	p, err := svc.Authenticate(ctx, token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if p.Username != username {
		t.Errorf("Authenticate() username = %q, want %q", p.Username, username)
	}
}

// TestServiceAuthenticateRejectsTokenIssuedBeforeRevocation (Sicherheits-
// Härtung 2026-08-10, ARCHITECTURE.md §20.4): der zentrale End-to-End-
// Test für die Session-Revocation — ein vor RevokeSessions ausgestelltes
// Token muss danach abgelehnt werden, obwohl Signatur und Ablaufzeit
// weiterhin gültig sind.
func TestServiceAuthenticateRejectsTokenIssuedBeforeRevocation(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()
	username := "test-svc-revoke-" + mustNewID(t)
	t.Cleanup(func() { _ = svc.DeleteUser(ctx, username) })

	if _, err := svc.CreateUser(ctx, username, "supersecret1"); err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	token, _, err := svc.Login(ctx, username, "supersecret1")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if _, err := svc.Authenticate(ctx, token); err != nil {
		t.Fatalf("Authenticate() before revocation, error = %v, want nil", err)
	}

	if err := svc.RevokeSessions(ctx, username); err != nil {
		t.Fatalf("RevokeSessions() error = %v", err)
	}

	if _, err := svc.Authenticate(ctx, token); err != ErrTokenRevoked {
		t.Fatalf("Authenticate() after revocation, error = %v, want ErrTokenRevoked", err)
	}
}

// TestServiceAuthenticateNewLoginAfterRevocationSucceeds stellt sicher,
// dass RevokeSessions nicht das Nutzerkonto insgesamt sperrt — nur
// bereits ausgestellte Tokens, ein neuer Login funktioniert sofort
// wieder.
func TestServiceAuthenticateNewLoginAfterRevocationSucceeds(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()
	username := "test-svc-relogin-" + mustNewID(t)
	t.Cleanup(func() { _ = svc.DeleteUser(ctx, username) })

	if _, err := svc.CreateUser(ctx, username, "supersecret1"); err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	if err := svc.RevokeSessions(ctx, username); err != nil {
		t.Fatalf("RevokeSessions() error = %v", err)
	}

	token, _, err := svc.Login(ctx, username, "supersecret1")
	if err != nil {
		t.Fatalf("Login() after revocation, error = %v", err)
	}
	if _, err := svc.Authenticate(ctx, token); err != nil {
		t.Fatalf("Authenticate() for a token issued after revocation, error = %v, want nil", err)
	}
}

// TestServiceSetPasswordRevokesExistingSessions (Sicherheits-Härtung
// 2026-08-10): ein Passwort-Wechsel muss automatisch alle zuvor
// ausgestellten Tokens ungültig machen.
func TestServiceSetPasswordRevokesExistingSessions(t *testing.T) {
	svc := newTestService(t)
	ctx := context.Background()
	username := "test-svc-pwchange-" + mustNewID(t)
	t.Cleanup(func() { _ = svc.DeleteUser(ctx, username) })

	if _, err := svc.CreateUser(ctx, username, "supersecret1"); err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	token, _, err := svc.Login(ctx, username, "supersecret1")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}

	if err := svc.SetPassword(ctx, username, "supersecret2"); err != nil {
		t.Fatalf("SetPassword() error = %v", err)
	}

	if _, err := svc.Authenticate(ctx, token); err != ErrTokenRevoked {
		t.Fatalf("Authenticate() with pre-password-change token, error = %v, want ErrTokenRevoked", err)
	}
}

// TestServiceAuthenticateIgnoresRevocationForServiceTokens (Sicherheits-
// Härtung 2026-08-10): ein Service-Token (issueService, Subject=Username=
// instanceID) hat keine Zeile in users — die Revocation-Prüfung darf
// solche Tokens nicht fälschlich ablehnen, sonst bräche jede Control-
// Plane-Instanz, die den Orchestrator-Proxy anspricht.
func TestServiceAuthenticateIgnoresRevocationForServiceTokens(t *testing.T) {
	svc := newTestService(t)
	instanceID := "inst-" + mustNewID(t)

	token, _, err := svc.IssueServiceToken(instanceID)
	if err != nil {
		t.Fatalf("IssueServiceToken() error = %v", err)
	}
	p, err := svc.Authenticate(context.Background(), token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v, want nil (no users row for a service token)", err)
	}
	if p.Username != instanceID {
		t.Errorf("Authenticate() username = %q, want %q", p.Username, instanceID)
	}
}

func TestSignerVerifyRoundTripsEpoch(t *testing.T) {
	signer := NewSigner([]byte("test-secret"))
	now := time.Now()
	token, _, err := signer.issue(Principal{UserID: "u1", Username: "alice", Epoch: 3}, now)
	if err != nil {
		t.Fatalf("issue() error = %v", err)
	}
	got, err := signer.verify(token, now)
	if err != nil {
		t.Fatalf("verify() error = %v", err)
	}
	if got.Epoch != 3 {
		t.Errorf("Epoch = %d, want 3", got.Epoch)
	}
}

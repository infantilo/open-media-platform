package auth

import (
	"context"
	"errors"
	"time"
)

// ErrInvalidCredentials wird von Login bei falschem Nutzernamen/Passwort
// geliefert — bewusst derselbe Fehler für "Nutzer existiert nicht" und
// "Passwort falsch" (kein Nutzernamen-Enumeration-Orakel).
var ErrInvalidCredentials = errors.New("auth: invalid credentials")

// Service bündelt Nutzerverwaltung, Passwort-Prüfung und Token-
// Ausstellung — die von httpapi genutzte Fassade dieses Pakets.
type Service struct {
	store  *Store
	signer *Signer
}

// NewService erstellt einen Service gegen store, Tokens signiert mit
// jwtSecret.
func NewService(store *Store, jwtSecret []byte) *Service {
	return &Service{store: store, signer: NewSigner(jwtSecret)}
}

// UserCount liefert die Anzahl angelegter Nutzer (0 = Bootstrap-Modus).
func (s *Service) UserCount(ctx context.Context) (int, error) {
	return s.store.Count(ctx)
}

// CreateUser hasht password und legt den Nutzer an.
func (s *Service) CreateUser(ctx context.Context, username, password string) (User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	return s.store.Create(ctx, username, hash)
}

// ListUsers liefert alle Nutzer (Administration-Tab, Kapitel 11 Teil 1).
func (s *Service) ListUsers(ctx context.Context) ([]User, error) {
	return s.store.List(ctx)
}

// DeleteUser entfernt einen Nutzer per Nutzername.
func (s *Service) DeleteUser(ctx context.Context, username string) error {
	return s.store.Delete(ctx, username)
}

// SetPassword hasht password und überschreibt den Hash des bestehenden
// Nutzers (Admin-Passwort-Reset).
func (s *Service) SetPassword(ctx context.Context, username, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return s.store.SetPasswordHash(ctx, username, hash)
}

// Login prüft Nutzername/Passwort und stellt bei Erfolg ein Token aus.
func (s *Service) Login(ctx context.Context, username, password string) (token string, expiresAt time.Time, err error) {
	u, ok, err := s.store.ByUsername(ctx, username)
	if err != nil {
		return "", time.Time{}, err
	}
	if !ok || !VerifyPassword(u.PasswordHash, password) {
		return "", time.Time{}, ErrInvalidCredentials
	}
	return s.signer.issue(Principal{UserID: u.ID, Username: u.Username}, time.Now())
}

// Authenticate verifiziert ein Bearer-Token und liefert den Principal.
func (s *Service) Authenticate(token string) (Principal, error) {
	return s.signer.verify(token, time.Now())
}

// IssueServiceToken stellt ein Bearer-Token für einen Service-Prinzipal
// aus (ARCHITECTURE.md §24.1, UMSETZUNG.md C16) — instanceID wird als
// authz-Subject verwendet, s. Signer.issueService-Doku. Aufrufer
// (httpapi.handleIssueServiceToken) verifiziert vorher das
// instanzeigene LaunchSecret; dieser Service selbst prüft keine
// Berechtigung, er signiert nur.
func (s *Service) IssueServiceToken(instanceID string) (token string, expiresAt time.Time, err error) {
	return s.signer.issueService(instanceID, time.Now())
}

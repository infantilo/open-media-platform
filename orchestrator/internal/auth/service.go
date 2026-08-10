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
//
// Sicherheits-Härtung 2026-08-10: widerruft danach zusätzlich alle
// laufenden Sitzungen dieses Nutzers — ein Passwort-Wechsel soll
// erwartungsgemäß jedes zuvor ausgestellte Token ungültig machen (z. B.
// nach Verdacht auf ein kompromittiertes Konto), nicht nur künftige
// Logins mit dem alten Passwort verhindern. Best effort: ein Fehler
// beim Widerruf lässt den bereits erfolgreichen Passwort-Wechsel
// bestehen (der Nutzer ist trotzdem nicht schlechter dran als vorher),
// wird aber an den Aufrufer durchgereicht, damit er sichtbar bleibt.
func (s *Service) SetPassword(ctx context.Context, username, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	if err := s.store.SetPasswordHash(ctx, username, hash); err != nil {
		return err
	}
	return s.store.RevokeSessions(ctx, username)
}

// Login prüft Nutzername/Passwort und stellt bei Erfolg ein Token aus.
// Bettet den aktuellen SessionsEpoch des Nutzers fest ins Token ein (s.
// Service.Authenticate) — ein Login, das unmittelbar nach einem
// RevokeSessions-Aufruf desselben Nutzers erfolgt, liest den bereits
// erhöhten Wert frisch aus der DB und bekommt ihn eingebettet, ganz
// unabhängig vom zeitlichen Abstand zum vorangegangenen Widerruf.
func (s *Service) Login(ctx context.Context, username, password string) (token string, expiresAt time.Time, err error) {
	u, ok, err := s.store.ByUsername(ctx, username)
	if err != nil {
		return "", time.Time{}, err
	}
	if !ok || !VerifyPassword(u.PasswordHash, password) {
		return "", time.Time{}, ErrInvalidCredentials
	}
	return s.signer.issue(Principal{UserID: u.ID, Username: u.Username, Epoch: u.SessionsEpoch}, time.Now())
}

// Authenticate verifiziert ein Bearer-Token und liefert den Principal.
//
// Sicherheits-Härtung 2026-08-10 (ARCHITECTURE.md §20.4): nach der
// (weiterhin zustandslosen) Signatur-/Ablauf-Prüfung ein zusätzlicher
// Abgleich des im Token eingebetteten Epoch-Werts gegen den aktuellen
// User.SessionsEpoch — weicht er ab, wurde der Nutzer seit dem
// Ausstellen dieses Tokens mindestens einmal widerrufen (RevokeSessions,
// s. dort), das Token gilt trotz gültiger Signatur/Ablaufzeit als
// ungültig. Bewusst NUR für echte Nutzerkonten: ein Service-Token
// (issueService, Subject=Username=instanceID) hat keine Zeile in
// users — ByUsername liefert dann ok=false, was hier als "nichts zu
// prüfen" behandelt wird, nicht als Fehler (sonst bräche jede
// Control-Plane-Instanz, die den Orchestrator-Proxy anspricht).
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	p, err := s.signer.verify(token, time.Now())
	if err != nil {
		return Principal{}, err
	}
	u, ok, err := s.store.ByUsername(ctx, p.Username)
	if err != nil {
		return Principal{}, err
	}
	if ok && p.Epoch != u.SessionsEpoch {
		return Principal{}, ErrTokenRevoked
	}
	return p, nil
}

// RevokeSessions (Sicherheits-Härtung 2026-08-10) invalidiert sofort
// jedes zuvor für username ausgestellte Token — für einen expliziten
// "an allen Geräten abmelden"-Admin-Eingriff bei Verdacht auf ein
// geleaktes Token, unabhängig von einem Passwort-Wechsel.
func (s *Service) RevokeSessions(ctx context.Context, username string) error {
	return s.store.RevokeSessions(ctx, username)
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

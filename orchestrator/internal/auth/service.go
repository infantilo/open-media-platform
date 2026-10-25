package auth

import (
	"context"
	"errors"
	"sync"
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

	cacheMu   sync.Mutex
	countAt   time.Time
	countVal  int
	userCache map[string]cachedUser
}

// authCacheTTL: so lange gelten UserCount und Nutzerzeile (Epoch/OrgID) aus
// dem Speicher — jede Request-Authentifizierung kostete vorher 2 DB-
// Roundtrips. Mutationen dieses Prozesses (Anlegen, Löschen, Passwort,
// Widerruf, Org-Wechsel) verwerfen den Cache sofort; die TTL begrenzt nur
// die Verzögerung bei Änderungen durch einen anderen Orchestrator.
const authCacheTTL = 2 * time.Second

type cachedUser struct {
	u  User
	ok bool
	at time.Time
}

func (s *Service) invalidateCache() {
	s.cacheMu.Lock()
	s.countAt = time.Time{}
	s.userCache = nil
	s.cacheMu.Unlock()
}

// NewService erstellt einen Service gegen store, Tokens signiert mit
// jwtSecret.
func NewService(store *Store, jwtSecret []byte) *Service {
	return &Service{store: store, signer: NewSigner(jwtSecret)}
}

// UserCount liefert die Anzahl angelegter Nutzer (0 = Bootstrap-Modus).
func (s *Service) UserCount(ctx context.Context) (int, error) {
	s.cacheMu.Lock()
	if time.Since(s.countAt) < authCacheTTL {
		n := s.countVal
		s.cacheMu.Unlock()
		return n, nil
	}
	s.cacheMu.Unlock()
	n, err := s.store.Count(ctx)
	if err != nil {
		return 0, err
	}
	s.cacheMu.Lock()
	s.countVal, s.countAt = n, time.Now()
	s.cacheMu.Unlock()
	return n, nil
}

// cachedByUsername ist ByUsername mit kurzem Cache (nur für Authenticate;
// Login liest bewusst frisch).
func (s *Service) cachedByUsername(ctx context.Context, username string) (User, bool, error) {
	s.cacheMu.Lock()
	if c, hit := s.userCache[username]; hit && time.Since(c.at) < authCacheTTL {
		s.cacheMu.Unlock()
		return c.u, c.ok, nil
	}
	s.cacheMu.Unlock()
	u, ok, err := s.store.ByUsername(ctx, username)
	if err != nil {
		return User{}, false, err
	}
	s.cacheMu.Lock()
	if s.userCache == nil || len(s.userCache) > 4096 {
		s.userCache = map[string]cachedUser{}
	}
	s.userCache[username] = cachedUser{u: u, ok: ok, at: time.Now()}
	s.cacheMu.Unlock()
	return u, ok, nil
}

// DefaultOrgID spiegelt organizations.DefaultOrgID (bewusst dupliziert
// statt importiert — dieses Paket kennt internal/organizations sonst
// nicht, gleiches Muster wie die Placement-/Audit-Default-Duplikation
// in internal/config). Der Default lebt HIER (nicht nur beim HTTP-
// Handler), damit JEDER Aufrufer von CreateUser (auch künftige, nicht
// nur httpapi.handleCreateUser) automatisch einen gültigen
// Fremdschlüssel-Wert bekommt, ohne sich selbst daran erinnern zu
// müssen.
const DefaultOrgID = "default"

// CreateUser hasht password und legt den Nutzer an. orgID leer =
// Default-Organisation (s. DefaultOrgID, Kapitel 21 B14).
func (s *Service) CreateUser(ctx context.Context, username, password, orgID string) (User, error) {
	if err := ValidatePassword(username, password); err != nil {
		return User{}, err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	if orgID == "" {
		orgID = DefaultOrgID
	}
	defer s.invalidateCache()
	return s.store.Create(ctx, username, hash, orgID)
}

// ListUsers liefert alle Nutzer (Administration-Tab, Kapitel 11 Teil 1).
func (s *Service) ListUsers(ctx context.Context) ([]User, error) {
	return s.store.List(ctx)
}

// DeleteUser entfernt einen Nutzer per Nutzername.
func (s *Service) DeleteUser(ctx context.Context, username string) error {
	defer s.invalidateCache()
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
	if err := ValidatePassword(username, password); err != nil {
		return err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	defer s.invalidateCache()
	if err := s.store.SetPasswordHash(ctx, username, hash); err != nil {
		return err
	}
	return s.store.RevokeSessions(ctx, username)
}

// UpdateUserOrg versetzt einen bestehenden Nutzer in eine andere
// Organisation (Kapitel 21 B14 UI-Anbindung, Nachtrag 284). orgID leer
// = Default-Organisation, gleiche Konvention wie CreateUser.
func (s *Service) UpdateUserOrg(ctx context.Context, username, orgID string) error {
	if orgID == "" {
		orgID = DefaultOrgID
	}
	defer s.invalidateCache()
	return s.store.UpdateOrg(ctx, username, orgID)
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
	return s.signer.issue(Principal{UserID: u.ID, Username: u.Username, Epoch: u.SessionsEpoch, OrgID: u.OrgID}, time.Now())
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
	u, ok, err := s.cachedByUsername(ctx, p.Username)
	if err != nil {
		return Principal{}, err
	}
	if !ok && !p.Service {
		// Nutzer-Token ohne Nutzerkonto: das Konto wurde gelöscht (Audit 2026-10-23 H3).
		return Principal{}, ErrTokenRevoked
	}
	if ok && p.Service {
		// Ein Service-Token trägt die Instanz-ID als Namen; gehört der Name einem Nutzerkonto, ist es keines.
		return Principal{}, ErrTokenInvalid
	}
	if ok && (p.Epoch != u.SessionsEpoch || p.UserID != u.ID) {
		// Epoche abweichend (Sitzungen widerrufen) oder gleicher Name, anderes Konto (gelöscht und neu angelegt).
		return Principal{}, ErrTokenRevoked
	}
	if ok {
		// OrgID kommt bewusst NICHT aus dem Token (s. Principal-Doku in
		// auth.go) — frisch aus der DB, damit ein Organisationswechsel
		// sofort wirkt. Service-Prinzipale (ok=false) bleiben ohne OrgID,
		// s. dortigen Kommentar.
		p.OrgID = u.OrgID
	}
	return p, nil
}

// RevokeSessions (Sicherheits-Härtung 2026-08-10) invalidiert sofort
// jedes zuvor für username ausgestellte Token — für einen expliziten
// "an allen Geräten abmelden"-Admin-Eingriff bei Verdacht auf ein
// geleaktes Token, unabhängig von einem Passwort-Wechsel.
func (s *Service) RevokeSessions(ctx context.Context, username string) error {
	defer s.invalidateCache()
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

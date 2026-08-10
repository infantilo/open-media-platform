package auth

import (
	"sync"
	"time"
)

// maxLoginFailures/loginFailureWindow/loginLockoutDuration (Sicherheits-
// Härtung 2026-08-10, ARCHITECTURE.md §20.4): vor dieser Änderung war
// POST /api/v1/auth/login uneingeschränkt oft aufrufbar — bcryptes
// Rechenkosten waren die einzige Bremse gegen automatisiertes
// Durchprobieren. 5 Fehlversuche innerhalb von 15 Minuten sperren den
// betroffenen Nutzernamen für 15 Minuten.
const (
	maxLoginFailures     = 5
	loginFailureWindow   = 15 * time.Minute
	loginLockoutDuration = 15 * time.Minute
)

// LoginLockout drosselt Login-Versuche pro Nutzername — bewusst
// IN-MEMORY statt in Postgres: der Orchestrator läuft als ein einzelner
// Prozess (kein horizontal skalierter Cluster), ein Neustart setzt
// bestehende Sperren zurück, was für dieses Bedrohungsmodell
// (automatisiertes Durchprobieren verlangsamen, nicht ein Angreifer mit
// Root auf der Maschine) ausreicht und ohne zusätzliches Schema/
// Migration auskommt.
//
// Zählt Fehlversuche unabhängig davon, ob der Nutzername überhaupt
// existiert — genau wie Service.Login() bewusst denselben Fehler für
// "Nutzer existiert nicht" und "Passwort falsch" liefert (kein
// Nutzernamen-Enumerations-Orakel), sonst würde ein Lockout selbst zu
// einem neuen Orakel ("dieser Nutzername kann gar nicht gesperrt
// werden → existiert nicht").
type LoginLockout struct {
	mu       sync.Mutex
	attempts map[string]*lockoutState
	// now ist austauschbar (Standard time.Now), damit Tests 15-Minuten-
	// Fenster ohne echtes Warten durchspielen können — dasselbe Prinzip
	// wie Signer.issue/verify in jwt.go, das now explizit als Parameter
	// nimmt statt intern time.Now() zu rufen.
	now func() time.Time
}

type lockoutState struct {
	failures    int
	windowStart time.Time
	lockedUntil time.Time
}

// NewLoginLockout erstellt einen leeren, prozesslokalen Lockout-Zustand.
func NewLoginLockout() *LoginLockout {
	return &LoginLockout{attempts: make(map[string]*lockoutState), now: time.Now}
}

// Locked meldet, ob username aktuell gesperrt ist.
func (l *LoginLockout) Locked(username string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.attempts[username]
	if !ok {
		return false
	}
	return l.now().Before(s.lockedUntil)
}

// RecordFailure zählt einen Fehlversuch für username. Ein neues
// Zeitfenster beginnt, sobald das vorige abgelaufen ist (auch während
// einer aktiven Sperre — ein weiterer Fehlversuch dort verlängert die
// Sperre stattdessen erneut um loginLockoutDuration, s. u.). Sobald
// maxLoginFailures innerhalb von loginFailureWindow erreicht sind, wird
// (erneut) gesperrt.
func (l *LoginLockout) RecordFailure(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	s, ok := l.attempts[username]
	if !ok || now.Sub(s.windowStart) > loginFailureWindow {
		s = &lockoutState{windowStart: now}
		l.attempts[username] = s
	}
	s.failures++
	if s.failures >= maxLoginFailures {
		s.lockedUntil = now.Add(loginLockoutDuration)
	}
}

// RecordSuccess löscht jeden verbleibenden Fehlversuchs-Zustand für
// username — ein erfolgreicher Login soll nicht durch längst
// zurückliegende, irrelevante Fehlversuche weiter nachwirken.
func (l *LoginLockout) RecordSuccess(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, username)
}

package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// bcrypt statt eines selbstgebauten KDF: Passwort-Hashing ist ein
// Bereich, in dem "aus Standardbibliothek selbst bauen" (die sonstige
// Minimal-Dependency-Regel, UMSETZUNG.md §0 Punkt 5) das falsche Prinzip
// wäre — Go hat keine Salting/Cost-Factor-KDF in der Standardbibliothek,
// und ein eigenes PBKDF2/Scrypt-Äquivalent aus crypto/sha256 zu bauen ist
// genau die Art "an Standards raten", die §0 Punkt 6/9 explizit
// ausschließt. golang.org/x/crypto ist zudem bereits eine transitive
// Abhängigkeit (nats.go, s. go.mod) — hier nur direkt importiert, keine
// neue Abhängigkeitswurzel. Siehe docs/decisions.md D3 Teil 2.
const bcryptCost = bcrypt.DefaultCost

// HashPassword erzeugt einen bcrypt-Hash für die Speicherung in
// users.password_hash.
func HashPassword(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword prüft plain gegen einen per HashPassword erzeugten Hash.
func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// ErrWeakPassword: das Passwort erfüllt die Mindestanforderungen nicht (Meldung nennt den Grund, keine Details zu anderen Konten).
var ErrWeakPassword = errors.New("auth: weak password")

// MinPasswordLength ist die Mindestlänge in Zeichen (Audit 2026-10-23 M4; per OMP_AUTH_MIN_PASSWORD änderbar).
var MinPasswordLength = 10

// maxPasswordBytes: bcrypt verarbeitet höchstens 72 Byte und lehnt mehr ab.
const maxPasswordBytes = 72

var commonPasswords = map[string]bool{
	"password": true, "passwort": true, "password1": true, "passwort1": true, "password123": true, "passwort123": true,
	"1234567890": true, "12345678910": true, "qwertzuiop": true, "qwertyuiop": true, "0123456789": true,
	"letmein123": true, "changeme123": true, "willkommen1": true, "welcome123": true, "iloveyou12": true,
}

// ValidatePassword prüft ein neues Passwort: Mindestlänge, höchstens 72 Byte (bcrypt), nicht nur ein wiederholtes Zeichen,
// nicht der Nutzername oder darin enthalten, nicht in einer kleinen Liste häufiger Passwörter. Keine Komplexitätsregeln
// (Zeichenklassen) — Länge zählt mehr als Sonderzeichen.
func ValidatePassword(username, password string) error {
	n := utf8.RuneCountInString(password)
	if n < MinPasswordLength {
		return fmt.Errorf("%w: at least %d characters required", ErrWeakPassword, MinPasswordLength)
	}
	if len(password) > maxPasswordBytes {
		return fmt.Errorf("%w: at most %d bytes allowed", ErrWeakPassword, maxPasswordBytes)
	}
	lower := strings.ToLower(password)
	if strings.Count(lower, lower[:1]) == len(lower) {
		return fmt.Errorf("%w: must not repeat a single character", ErrWeakPassword)
	}
	if u := strings.ToLower(strings.TrimSpace(username)); len(u) >= 3 && strings.Contains(lower, u) {
		return fmt.Errorf("%w: must not contain the user name", ErrWeakPassword)
	}
	if commonPasswords[lower] {
		return fmt.Errorf("%w: too common", ErrWeakPassword)
	}
	return nil
}

package auth

import "golang.org/x/crypto/bcrypt"

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

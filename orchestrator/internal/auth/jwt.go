package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TokenTTL ist die Gültigkeitsdauer eines ausgestellten Tokens — eine
// typische Schichtlänge im Sendebetrieb (§12: Regieplatz-Bedienung über
// eine Sitzung hinweg), lang genug, dass ein Operator nicht mitten in
// einer Sendung erneut anmelden muss, kurz genug, dass ein
// kompromittiertes Token nicht unbegrenzt gültig bleibt. Kein
// Refresh-Token-Mechanismus in dieser Runde (würde Revocation-Zustand
// brauchen, den es noch nicht gibt) — bewusster Scope-Schnitt, s.
// docs/decisions.md D3 Teil 2.
const TokenTTL = 12 * time.Hour

var (
	// ErrTokenInvalid deckt jede strukturelle/Signatur-Verletzung ab.
	ErrTokenInvalid = errors.New("auth: token invalid")
	// ErrTokenExpired ist separat, damit Aufrufer (falls gewünscht) eine
	// eigene "bitte neu anmelden"-Meldung zeigen können.
	ErrTokenExpired = errors.New("auth: token expired")
)

// claims ist der JWT-Payload — bewusst schlank (NMOS IS-10/BCP-003-02
// beschreibt den Bearer-Token-Transport, nicht ein festes Claim-Set;
// `sub`/sub Username reichen für die aktuelle §12-Durchsetzung, die
// ohnehin bei jedem Request live gegen role_bindings prüft statt Rollen
// im Token selbst zu tragen — ein abgelaufenes/widerrufenes Binding
// greift damit sofort, ohne auf Token-Ablauf warten zu müssen).
type claims struct {
	Subject  string `json:"sub"`
	Username string `json:"username"`
	IssuedAt int64  `json:"iat"`
	ExpireAt int64  `json:"exp"`
}

const jwtHeader = `{"alg":"HS256","typ":"JWT"}`

// Signer signiert/verifiziert Tokens mit einem gemeinsamen HMAC-Secret.
//
// Handgebautes minimales HS256-JWT statt einer Bibliothek
// (golang-jwt/jwt o. Ä.): der gebrauchte Umfang ist genau ein
// Algorithmus, ein Claim-Set, keine JWKS/Multi-Issuer-Rotation — HS256
// ist mit crypto/hmac + encoding/json + encoding/base64 aus der
// Standardbibliothek in unter 100 Zeilen korrekt umsetzbar, eine externe
// Abhängigkeit wäre hier Overhead ohne Gegenwert (UMSETZUNG.md §0 Punkt
// 5). Anders als bei bcrypt oben (password.go) gibt es hier kein
// spezialisiertes kryptographisches Primitiv, das man nicht selbst
// zusammensetzen sollte — HMAC-Verifikation ist Lehrbuch-Anwendung von
// crypto/hmac, kein KDF-Design. Siehe docs/decisions.md D3 Teil 2.
type Signer struct {
	secret []byte
}

// NewSigner erstellt einen Signer mit dem gegebenen HMAC-Secret.
func NewSigner(secret []byte) *Signer {
	return &Signer{secret: secret}
}

func (s *Signer) sign(unsigned string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(unsigned))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// issue erstellt ein signiertes Token für den gegebenen Principal.
func (s *Signer) issue(p Principal, now time.Time) (string, time.Time, error) {
	exp := now.Add(TokenTTL)
	c := claims{Subject: p.UserID, Username: p.Username, IssuedAt: now.Unix(), ExpireAt: exp.Unix()}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: marshal claims: %w", err)
	}
	unsigned := base64.RawURLEncoding.EncodeToString([]byte(jwtHeader)) + "." +
		base64.RawURLEncoding.EncodeToString(payload)
	token := unsigned + "." + s.sign(unsigned)
	return token, exp, nil
}

// verify prüft Signatur und Ablauf eines Tokens und liefert den
// enthaltenen Principal.
func (s *Signer) verify(token string, now time.Time) (Principal, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Principal{}, ErrTokenInvalid
	}
	unsigned := parts[0] + "." + parts[1]
	wantSig := s.sign(unsigned)
	// subtle.ConstantTimeCompare gegen Timing-Angriffe auf den
	// Signaturvergleich — Standard-Praxis für HMAC-Verifikation.
	if subtle.ConstantTimeCompare([]byte(wantSig), []byte(parts[2])) != 1 {
		return Principal{}, ErrTokenInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Principal{}, ErrTokenInvalid
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return Principal{}, ErrTokenInvalid
	}
	if c.Subject == "" {
		return Principal{}, ErrTokenInvalid
	}
	if now.Unix() > c.ExpireAt {
		return Principal{}, ErrTokenExpired
	}
	return Principal{UserID: c.Subject, Username: c.Username}, nil
}

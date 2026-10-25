package jobwire

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"
	"time"
)

// Signierte Host-Kommandos (Audit 2026-10-23 B2): Der Host-Agent führte jedes Kommando auf seinem NATS-Subject aus. Jetzt
// signiert der Orchestrator jedes Kommando mit einem je Host geheimen Schlüssel (HMAC-SHA256 über Subject, Zeitstempel,
// Einmalwert und Nutzlast); die Signatur reist in NATS-Headern, die Nutzlast bleibt unverändert. Der Agent prüft Signatur,
// Frist und Wiederholung, sobald er einen Schlüssel kennt.

// Header-Namen.
const (
	HeaderSig   = "Omp-Sig"
	HeaderTs    = "Omp-Ts"
	HeaderNonce = "Omp-Nonce"
)

// ActionProvisionKey liefert dem Agent erstmals seinen Schlüssel (nur ohne bisherigen Schlüssel; „trust on first use“ für
// Hosts, die vor Einführung der Signatur registriert wurden). Neue Hosts bekommen den Schlüssel bei der Registrierung.
const ActionProvisionKey = "provision-key"

// ActionRotateKey ersetzt den Schlüssel des Agents (signiert mit dem bisherigen).
const ActionRotateKey = "rotate-key"

// MaxSkew ist die erlaubte Abweichung zwischen Zeitstempel und Uhr des Agents.
const MaxSkew = 2 * time.Minute

// Fehler der Prüfung.
var (
	ErrUnsigned  = errors.New("command is not signed")
	ErrBadSig    = errors.New("command signature invalid")
	ErrStale     = errors.New("command timestamp outside the allowed window")
	ErrReplayed  = errors.New("command nonce already used")
	errBadHeader = errors.New("command headers malformed")
)

// NewKey erzeugt einen zufälligen Schlüssel (32 Byte, Base64-URL).
func NewKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func mac(key, subject, ts, nonce string, payload []byte) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(subject))
	h.Write([]byte{0})
	h.Write([]byte(ts))
	h.Write([]byte{0})
	h.Write([]byte(nonce))
	h.Write([]byte{0})
	h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))
}

// Sign liefert die Header-Werte für ein Kommando.
func Sign(key, subject string, payload []byte, now time.Time) (ts, nonce, sig string, err error) {
	n := make([]byte, 12)
	if _, err = rand.Read(n); err != nil {
		return
	}
	ts = strconv.FormatInt(now.Unix(), 10)
	nonce = hex.EncodeToString(n)
	sig = mac(key, subject, ts, nonce, payload)
	return
}

// Verifier prüft Kommandos eines Agents gegen seinen Schlüssel und merkt sich die Einmalwerte der letzten MaxSkew.
type Verifier struct {
	mu    sync.Mutex
	key   string
	seen  map[string]time.Time
	nowFn func() time.Time
}

// NewVerifier legt einen Prüfer an (key leer = keine Prüfung, Active() false).
func NewVerifier(key string) *Verifier {
	return &Verifier{key: key, seen: map[string]time.Time{}, nowFn: time.Now}
}

// Active: es gibt einen Schlüssel, Kommandos müssen signiert sein.
func (v *Verifier) Active() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.key != ""
}

// SetKey setzt den Schlüssel (nach der Provisionierung).
func (v *Verifier) SetKey(key string) {
	v.mu.Lock()
	v.key = key
	v.mu.Unlock()
}

// Verify prüft ein Kommando; header liefert den Wert eines Headers ("" wenn fehlt).
func (v *Verifier) Verify(subject string, payload []byte, header func(string) string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.key == "" {
		return nil
	}
	ts, nonce, sig := header(HeaderTs), header(HeaderNonce), header(HeaderSig)
	if ts == "" || nonce == "" || sig == "" {
		return ErrUnsigned
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(nonce) > 64 || len(sig) > 128 {
		return errBadHeader
	}
	now := v.nowFn()
	if d := now.Sub(time.Unix(sec, 0)); d > MaxSkew || d < -MaxSkew {
		return ErrStale
	}
	if !hmac.Equal([]byte(mac(v.key, subject, ts, nonce, payload)), []byte(sig)) {
		return ErrBadSig
	}
	for n, at := range v.seen {
		if now.Sub(at) > 2*MaxSkew {
			delete(v.seen, n)
		}
	}
	if _, dup := v.seen[nonce]; dup {
		return ErrReplayed
	}
	v.seen[nonce] = now
	return nil
}

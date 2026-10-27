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
	// HeaderTerm trägt die Raft-Amtszeit des sendenden Orchestrators (Audit H4/M10, Fencing): ein Agent, der schon eine höhere Amtszeit gesehen hat,
	// weist Kommandos eines früheren Leaders ab. Die Amtszeit ist von der Signatur abgedeckt.
	HeaderTerm = "Omp-Term"
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
	ErrStaleTerm = errors.New("command from a superseded leader (term too old)")
	ErrNoTerm    = errors.New("command without leader term although the agent already follows terms")
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

func mac(key, subject, ts, nonce, term string, payload []byte) string {
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(subject))
	h.Write([]byte{0})
	h.Write([]byte(ts))
	h.Write([]byte{0})
	h.Write([]byte(nonce))
	h.Write([]byte{0})
	if term != "" { // ohne Amtszeit bleibt die Signatur wie vor dem Fencing
		h.Write([]byte("term="))
		h.Write([]byte(term))
		h.Write([]byte{0})
	}
	h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))
}

// Sign liefert die Header-Werte für ein Kommando.
func Sign(key, subject string, payload []byte, now time.Time) (ts, nonce, sig string, err error) {
	return SignTerm(key, subject, payload, now, 0)
}

// SignTerm wie Sign, mit der Raft-Amtszeit des Absenders (0 = keine). Die Amtszeit reist im Header HeaderTerm (FormatTerm).
func SignTerm(key, subject string, payload []byte, now time.Time, term uint64) (ts, nonce, sig string, err error) {
	n := make([]byte, 12)
	if _, err = rand.Read(n); err != nil {
		return
	}
	ts = strconv.FormatInt(now.Unix(), 10)
	nonce = hex.EncodeToString(n)
	sig = mac(key, subject, ts, nonce, FormatTerm(term), payload)
	return
}

// FormatTerm: Headerwert der Amtszeit ("" für 0).
func FormatTerm(term uint64) string {
	if term == 0 {
		return ""
	}
	return strconv.FormatUint(term, 10)
}

// Verifier prüft Kommandos eines Agents gegen seinen Schlüssel und merkt sich die Einmalwerte der letzten MaxSkew.
type Verifier struct {
	mu    sync.Mutex
	key   string
	seen  map[string]time.Time
	nowFn func() time.Time
	// maxTerm: höchste bisher gesehene Amtszeit; onTerm speichert sie dauerhaft (State-Datei), damit ein Neustart des Agents sie nicht vergisst.
	maxTerm uint64
	onTerm  func(uint64)
}

// SetTerm setzt die zuletzt gespeicherte Amtszeit und den Speicherhaken.
func (v *Verifier) SetTerm(max uint64, persist func(uint64)) {
	v.mu.Lock()
	v.maxTerm, v.onTerm = max, persist
	v.mu.Unlock()
}

// MaxTerm: höchste gesehene Amtszeit.
func (v *Verifier) MaxTerm() uint64 {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.maxTerm
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
	termHdr := header(HeaderTerm)
	if !hmac.Equal([]byte(mac(v.key, subject, ts, nonce, termHdr, payload)), []byte(sig)) {
		return ErrBadSig
	}
	// Fencing (Audit H4/M10): ein früherer Leader (kleinere Amtszeit) darf nichts mehr ausführen lassen. Hat der Agent einmal Amtszeiten gesehen,
	// genügt ein Kommando ohne Amtszeit nicht mehr (sonst wäre das Fencing durch Weglassen des Headers zu umgehen).
	if termHdr != "" {
		term, err := strconv.ParseUint(termHdr, 10, 64)
		if err != nil {
			return errBadHeader
		}
		if term < v.maxTerm {
			return ErrStaleTerm
		}
		if term > v.maxTerm {
			v.maxTerm = term
			if v.onTerm != nil {
				v.onTerm(term)
			}
		}
	} else if v.maxTerm > 0 {
		return ErrNoTerm
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

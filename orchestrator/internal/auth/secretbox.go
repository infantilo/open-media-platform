package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

// WrapKeyEnv nennt die Datei, deren Inhalt die Geheimnisse in app_secrets verschlüsselt (Review 2026-11-27 B6):
// ein Datenbank-Abzug allein reicht dann nicht, um Tokens zu fälschen.
const WrapKeyEnv = "OMP_AUTH_SECRET_WRAP_KEY_FILE"

const sealedPrefix = "enc:v1:"

// ErrNoWrapKey: in der Datenbank liegt ein verschlüsselter Wert, dieser Prozess hat aber keinen Schlüssel dafür.
var ErrNoWrapKey = errors.New("auth: stored secret is encrypted, set " + WrapKeyEnv)

// SecretBox ver- und entschlüsselt gespeicherte Geheimnisse mit AES-256-GCM; nil = Klartext (ohne WrapKeyEnv).
type SecretBox struct{ aead cipher.AEAD }

// LoadSecretBox liest den Schlüssel aus path ("" = keine Verschlüsselung). Der Schlüssel ist der SHA-256 des
// Dateiinhalts ohne umgebende Leerzeichen; mindestens 32 Zeichen (z. B. openssl rand -hex 32).
func LoadSecretBox(path string) (*SecretBox, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("auth: read wrap key: %w", err)
	}
	text := strings.TrimSpace(string(data))
	if len(text) < 32 {
		return nil, fmt.Errorf("auth: wrap key in %s is shorter than 32 characters", path)
	}
	key := sha256.Sum256([]byte(text))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretBox{aead: aead}, nil
}

// seal liefert den zu speichernden Wert. name bindet den Wert an seine Zeile.
func (b *SecretBox) seal(name, plain string) (string, error) {
	if b == nil {
		return plain, nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return sealedPrefix + base64.RawStdEncoding.EncodeToString(b.aead.Seal(nonce, nonce, []byte(plain), []byte(name))), nil
}

// open liest einen gespeicherten Wert; sealed meldet, ob er verschlüsselt war.
func (b *SecretBox) open(name, stored string) (plain string, sealed bool, err error) {
	rest, sealed := strings.CutPrefix(stored, sealedPrefix)
	if !sealed {
		return stored, false, nil
	}
	if b == nil {
		return "", true, ErrNoWrapKey
	}
	raw, err := base64.RawStdEncoding.DecodeString(rest)
	if err != nil || len(raw) < b.aead.NonceSize() {
		return "", true, fmt.Errorf("auth: app_secrets.%s is damaged", name)
	}
	out, err := b.aead.Open(nil, raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():], []byte(name))
	if err != nil {
		return "", true, fmt.Errorf("auth: app_secrets.%s cannot be decrypted (wrong key in %s?)", name, WrapKeyEnv)
	}
	return string(out), true, nil
}

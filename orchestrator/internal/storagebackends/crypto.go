package storagebackends

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// ErrMasterKeyInvalid — OMP_STORAGE_SECRET_KEY muss Base64-kodierte 32
// Rohbytes sein (AES-256). Go-Standardbibliothek only (crypto/aes,
// crypto/cipher) — keine neue Abhängigkeit für ein einzelnes
// Verschlüsselungsprimitiv (Minimal-Dependency-Regel, §0 Punkt 5).
var ErrMasterKeyInvalid = errors.New("storagebackends: OMP_STORAGE_SECRET_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key)")

func decodeMasterKey(b64 string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMasterKeyInvalid, err)
	}
	if len(key) != 32 {
		return nil, ErrMasterKeyInvalid
	}
	return key, nil
}

// encryptSecret liefert nonce||ciphertext (AES-256-GCM, zufälliger
// Nonce je Aufruf — zwei Backends mit demselben Secret Key erzeugen
// dadurch unterschiedliche Ciphertexte, kein Muster ablesbar).
func encryptSecret(key []byte, plaintext string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func decryptSecret(key []byte, ciphertext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return "", errors.New("storagebackends: stored secret is shorter than the GCM nonce, cannot decrypt")
	}
	nonce, ct := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("storagebackends: decrypt secret (wrong OMP_STORAGE_SECRET_KEY?): %w", err)
	}
	return string(pt), nil
}

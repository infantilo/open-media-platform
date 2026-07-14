package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LoadOrCreateSecret liest das HMAC-Secret für die Token-Signierung aus
// path; existiert die Datei nicht, wird ein neues, zufälliges Secret
// erzeugt und dort abgelegt (0600 — nur der Orchestrator-Prozess-Nutzer
// darf es lesen). Zero-Config-Dev-Default, gleicher Gedanke wie
// deploy/catalog.json/role-bindings.json vor D3: kein manueller
// Vorbereitungsschritt nötig, aber per OMP_AUTH_JWT_SECRET_FILE
// überschreibbar für echte Deployments (dort z. B. auf ein gemountetes
// Secret zeigen). Persistenz ist notwendig, weil ein bei jedem Neustart
// neu gewürfeltes Secret alle vorher ausgestellten Tokens ungültig
// machen würde — Nutzer müssten sich nach jedem Orchestrator-Neustart
// neu anmelden.
func LoadOrCreateSecret(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		secret, decodeErr := hex.DecodeString(string(data))
		if decodeErr != nil {
			return nil, fmt.Errorf("auth: %s does not contain a valid hex secret: %w", path, decodeErr)
		}
		return secret, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("auth: read secret file: %w", err)
	}

	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("auth: generate secret: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("auth: create secret directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(secret)), 0o600); err != nil {
		return nil, fmt.Errorf("auth: write secret file: %w", err)
	}
	return secret, nil
}

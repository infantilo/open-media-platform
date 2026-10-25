package auth

import (
	"crypto/rand"
	"database/sql"
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

// LoadOrCreateSharedSecret liefert das Token-Secret aus der Datenbank, damit alle Orchestrator-Instanzen eines Clusters
// dasselbe benutzen (Audit 2026-10-23 H10). Gibt es dort noch keines, wird das der lokalen Datei übernommen (bestehende
// Tokens bleiben gültig) bzw. neu erzeugt und eingetragen; gleichzeitige Starter einigen sich über ON CONFLICT auf einen Wert.
func LoadOrCreateSharedSecret(db *sql.DB, filePath string) ([]byte, error) {
	const name = "auth_jwt_secret"
	read := func() ([]byte, bool, error) {
		var v string
		err := db.QueryRow(`SELECT value FROM app_secrets WHERE name = $1`, name).Scan(&v)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		b, err := hex.DecodeString(v)
		if err != nil || len(b) < 16 {
			return nil, false, fmt.Errorf("auth: app_secrets.%s is not a valid hex secret", name)
		}
		return b, true, nil
	}
	if b, ok, err := read(); err != nil || ok {
		return b, err
	}
	seed, err := LoadOrCreateSecret(filePath)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, name, hex.EncodeToString(seed)); err != nil {
		return nil, fmt.Errorf("auth: store shared secret: %w", err)
	}
	b, ok, err := read()
	if err != nil || !ok {
		return nil, fmt.Errorf("auth: shared secret missing after insert: %v", err)
	}
	return b, nil
}

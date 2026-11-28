package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Zeilen in app_secrets für den Signaturschlüssel der Tokens. Fehlen sie, signiert das Wurzelgeheimnis
// (auth_jwt_secret) — der Stand vor der ersten Rotation. Aus dem Wurzelgeheimnis abgeleitete Node- und
// Cluster-Token ändern sich durch eine Rotation nicht.
const (
	signingKeyName  = "auth_signing_key"
	previousKeyName = "auth_signing_key_previous"
)

const (
	ringMaxAge     = 30 * time.Second // so spät sieht eine andere Instanz eine Rotation spätestens
	ringRetryAfter = time.Second      // frühestens so bald lädt ein unbekanntes Token erneut nach
)

// KeyRing hält den aktuellen und den vorherigen Signaturschlüssel aus der Datenbank.
type KeyRing struct {
	db   *sql.DB
	box  *SecretBox
	root []byte

	mu       sync.Mutex
	current  []byte
	previous []byte
	until    time.Time // so lange gilt previous
	loadedAt time.Time
}

// NewKeyRing lädt die Schlüssel; root ist das gemeinsame Wurzelgeheimnis.
func NewKeyRing(ctx context.Context, db *sql.DB, box *SecretBox, root []byte) (*KeyRing, error) {
	r := &KeyRing{db: db, box: box, root: root, current: root}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r, r.load(ctx)
}

// load: Aufrufer hält r.mu. Bei einem Fehler bleiben die bisherigen Schlüssel.
func (r *KeyRing) load(ctx context.Context) error {
	r.loadedAt = time.Now()
	rows, err := r.db.QueryContext(ctx, `SELECT name, value, created_at FROM app_secrets WHERE name IN ($1, $2)`, signingKeyName, previousKeyName)
	if err != nil {
		return fmt.Errorf("auth: load signing keys: %w", err)
	}
	defer rows.Close()
	current, previous, until := r.root, []byte(nil), time.Time{}
	for rows.Next() {
		var name, stored string
		var created time.Time
		if err := rows.Scan(&name, &stored, &created); err != nil {
			return err
		}
		plain, _, err := r.box.open(name, stored)
		if err != nil {
			return err
		}
		key, err := hex.DecodeString(plain)
		if err != nil || len(key) < 16 {
			return fmt.Errorf("auth: app_secrets.%s is not a valid hex secret", name)
		}
		if name == signingKeyName {
			current = key
		} else {
			// Danach ist jedes mit ihm signierte Token abgelaufen.
			previous, until = key, created.Add(ServiceTokenTTL)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	r.current, r.previous, r.until = current, previous, until
	return nil
}

// keys liefert die gültigen Schlüssel, den aktuellen zuerst. unknown: ein Token passte zu keinem — dann wird
// auch vor Ablauf von ringMaxAge nachgeladen (eine andere Instanz kann gerade rotiert haben).
func (r *KeyRing) keys(unknown bool) [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if age := time.Since(r.loadedAt); age > ringMaxAge || (unknown && age > ringRetryAfter) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = r.load(ctx) // Datenbank kurz weg: mit dem bekannten Stand weiterarbeiten
	}
	out := [][]byte{r.current}
	if r.previous != nil && time.Now().Before(r.until) {
		out = append(out, r.previous)
	}
	return out
}

// Rotate erzeugt einen neuen Signaturschlüssel. Mit dropPrevious gelten alle bisher ausgestellten Tokens sofort
// nicht mehr (Schlüssel kompromittiert), sonst laufen sie normal aus.
func (r *KeyRing) Rotate(ctx context.Context, dropPrevious bool) error {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Gleichzeitige Rotationen nacheinander ausführen.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, signingKeyName); err != nil {
		return err
	}
	old := hex.EncodeToString(r.root)
	var stored string
	switch err := tx.QueryRowContext(ctx, `SELECT value FROM app_secrets WHERE name = $1`, signingKeyName).Scan(&stored); {
	case err == nil:
		if old, _, err = r.box.open(signingKeyName, stored); err != nil {
			return err
		}
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM app_secrets WHERE name IN ($1, $2)`, signingKeyName, previousKeyName); err != nil {
		return err
	}
	values := map[string]string{signingKeyName: hex.EncodeToString(key)}
	if !dropPrevious {
		values[previousKeyName] = old
	}
	for name, plain := range values {
		sealed, err := r.box.seal(name, plain)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO app_secrets (name, value) VALUES ($1, $2)`, name, sealed); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("auth: rotate signing key: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.load(ctx)
}

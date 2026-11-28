package auth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func testBox(t *testing.T, key string) *SecretBox {
	t.Helper()
	path := filepath.Join(t.TempDir(), "wrap")
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	box, err := LoadSecretBox(path)
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func TestSharedSecretIsEncryptedAndKeepsItsValue(t *testing.T) {
	database := dbtest.Open(t)
	file := filepath.Join(t.TempDir(), "jwt")
	plain, err := LoadOrCreateSharedSecret(database, file, nil)
	if err != nil {
		t.Fatal(err)
	}
	box := testBox(t, strings.Repeat("a", 64))
	sealed, err := LoadOrCreateSharedSecret(database, file, box) // vorhandener Klartext wird umgeschrieben
	if err != nil || string(sealed) != string(plain) {
		t.Fatalf("err = %v, gleich = %v", err, string(sealed) == string(plain))
	}
	var stored string
	if err := database.QueryRow(`SELECT value FROM app_secrets WHERE name = 'auth_jwt_secret'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, sealedPrefix) {
		t.Fatalf("nicht verschlüsselt: %q", stored)
	}
	again, err := LoadOrCreateSharedSecret(database, file, box)
	if err != nil || string(again) != string(plain) {
		t.Fatalf("erneut laden: %v", err)
	}
	if _, err := LoadOrCreateSharedSecret(database, file, nil); !errors.Is(err, ErrNoWrapKey) {
		t.Fatalf("ohne Schlüssel: %v", err)
	}
	if _, err := LoadOrCreateSharedSecret(database, file, testBox(t, strings.Repeat("b", 64))); err == nil {
		t.Fatal("falscher Schlüssel muss scheitern")
	}
	if _, err := LoadSecretBox(file + "-fehlt"); err == nil {
		t.Fatal("fehlende Schlüsseldatei muss scheitern")
	}
}

func TestKeyRingRotation(t *testing.T) {
	database := dbtest.Open(t)
	ctx := context.Background()
	box := testBox(t, strings.Repeat("c", 64))
	root := []byte("wurzelgeheimnis-0123456789abcdef")
	newSigner := func() (*Signer, *KeyRing) {
		ring, err := NewKeyRing(ctx, database, box, root)
		if err != nil {
			t.Fatal(err)
		}
		return &Signer{secret: root, ring: ring}, ring
	}
	first, ring := newSigner()
	other, otherRing := newSigner() // zweite Orchestrator-Instanz
	who := Principal{UserID: "u1", Username: "anna"}
	issue := func(s *Signer) string {
		token, _, err := s.issue(who, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	valid := func(s *Signer, token string) bool { _, err := s.verify(token, time.Now()); return err == nil }

	before := issue(first)
	if !valid(NewSigner(root), before) {
		t.Fatal("vor der Rotation signiert das Wurzelgeheimnis")
	}
	if err := ring.Rotate(ctx, false); err != nil {
		t.Fatal(err)
	}
	after := issue(first)
	if !valid(first, before) || !valid(first, after) || valid(NewSigner(root), after) {
		t.Fatal("nach der Rotation gelten alt und neu, signiert wird neu")
	}
	otherRing.loadedAt = time.Now().Add(-2 * ringRetryAfter) // sonst greift die Nachlade-Bremse
	if !valid(other, after) {
		t.Fatal("andere Instanz muss bei unbekanntem Token nachladen")
	}
	// Zweite Rotation: der erste Schlüssel fällt heraus.
	if err := ring.Rotate(ctx, false); err != nil {
		t.Fatal(err)
	}
	if valid(first, before) || !valid(first, after) {
		t.Fatal("es gilt nur der unmittelbar vorherige Schlüssel")
	}
	// Abgelaufener Vorgänger zählt nicht mehr.
	if _, err := database.Exec(`UPDATE app_secrets SET created_at = now() - interval '25 hours' WHERE name = $1`, previousKeyName); err != nil {
		t.Fatal(err)
	}
	if _, fresh := newSigner(); len(fresh.keys(false)) != 1 {
		t.Fatal("alter Vorgänger gilt noch")
	}
	// Notfall: alles Bisherige sofort ungültig.
	last := issue(first)
	if err := ring.Rotate(ctx, true); err != nil {
		t.Fatal(err)
	}
	if valid(first, last) || !valid(first, issue(first)) {
		t.Fatal("dropPrevious muss alte Tokens sofort verwerfen")
	}
}

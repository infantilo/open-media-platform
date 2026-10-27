package supportaccess

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func newStore(t *testing.T) *Store {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE support_access`); err != nil {
		t.Fatal(err)
	}
	return NewStore(db)
}

func TestCreateVerifyAndStoredHashOnly(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	g, token, err := s.Create(ctx, "anna", "Ticket 4711", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, TokenPrefix) || g.ExpiresAt.Sub(g.CreatedAt) != time.Hour || g.Note != "Ticket 4711" {
		t.Fatalf("%+v %s", g, token)
	}
	got, err := s.Verify(ctx, token)
	if err != nil || got.ID != g.ID || got.CreatedBy != "anna" {
		t.Fatalf("%+v %v", got, err)
	}
	// Das Token steht nirgends im Klartext in der Datenbank
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM support_access WHERE token_hash = $1 OR id = $1`, token).Scan(&n); err != nil || n != 0 {
		t.Fatalf("Klartext-Token gefunden: %d %v", n, err)
	}
	for _, bad := range []string{"", "ompsup_", "ompsup_falsch.falsch", "jwt.header.sig", TokenPrefix + strings.Repeat("x", 300)} {
		if _, err := s.Verify(ctx, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q: %v", bad[:min(len(bad), 20)], err)
		}
	}
}

func TestExpiryAndRevocationTakeEffectImmediately(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	base := time.Now()
	s.now = func() time.Time { return base }
	g, token, err := s.Create(ctx, "anna", "", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Verify(ctx, token); err != nil {
		t.Fatal(err)
	}
	// Ablauf wirkt auch mit dem Zwischenspeicher, ohne Wartezeit
	s.now = func() time.Time { return base.Add(10*time.Minute + time.Second) }
	if _, err := s.Verify(ctx, token); !errors.Is(err, ErrExpired) {
		t.Fatalf("abgelaufen: %v", err)
	}
	// Widerruf wirkt ab der nächsten Anfrage
	s.now = func() time.Time { return base }
	g2, token2, _ := s.Create(ctx, "anna", "", time.Hour)
	if _, err := s.Verify(ctx, token2); err != nil {
		t.Fatal(err)
	}
	if err := s.Revoke(ctx, g2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Verify(ctx, token2); !errors.Is(err, ErrRevoked) {
		t.Fatalf("widerrufen: %v", err)
	}
	if err := s.Revoke(ctx, g2.ID); err != nil { // zweiter Widerruf ist kein Fehler
		t.Fatal(err)
	}
	if err := s.Revoke(ctx, "gibtsnicht"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unbekannt: %v", err)
	}
	list, err := s.List(ctx, 10)
	if err != nil || len(list) != 2 {
		t.Fatalf("%v %d", err, len(list))
	}
	status := map[string]string{}
	for _, x := range list {
		status[x.ID] = x.Status(base.Add(11 * time.Minute))
	}
	if status[g.ID] != "expired" || status[g2.ID] != "revoked" {
		t.Fatalf("%v", status)
	}
}

func TestLimitsAndLoginCounting(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, _, err := s.Create(ctx, "a", "", time.Minute); !errors.Is(err, ErrBadTime) {
		t.Errorf("zu kurz: %v", err)
	}
	if _, _, err := s.Create(ctx, "a", "", 8*24*time.Hour); !errors.Is(err, ErrBadTime) {
		t.Errorf("zu lang: %v", err)
	}
	g, _, err := s.Create(ctx, "a", strings.Repeat("ä", 300), time.Hour)
	if err != nil || len([]rune(g.Note)) != maxNoteRunes {
		t.Fatalf("Notiz nicht gekürzt: %v %d", err, len([]rune(g.Note)))
	}
	if err := s.MarkLogin(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkLogin(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	list, _ := s.List(ctx, 5)
	if list[0].UseCount != 2 || list[0].FirstUsedAt == nil || list[0].LastUsedAt == nil {
		t.Fatalf("%+v", list[0])
	}
	for i := 0; i < maxActive-1; i++ {
		if _, _, err := s.Create(ctx, "a", "", time.Hour); err != nil {
			t.Fatalf("%d: %v", i, err)
		}
	}
	if _, _, err := s.Create(ctx, "a", "", time.Hour); !errors.Is(err, ErrTooMany) {
		t.Fatalf("Obergrenze: %v", err)
	}
}

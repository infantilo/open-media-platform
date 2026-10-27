// Package supportaccess: befristeter, nur lesender Zugang für den Support (UMSETZUNG.md Kap. 72.9).
//
// Ein Administrator erzeugt einen Zugang mit Ablaufzeit und gibt dem Support den Link. Das Token wird zufällig erzeugt, nur als SHA-256
// gespeichert und dem Administrator genau einmal angezeigt. Es gilt bis zum Ablauf oder bis zum Widerruf; jede Anfrage prüft beides frisch.
package supportaccess

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// TokenPrefix kennzeichnet ein Support-Token (gegenüber den JWTs der Nutzerkonten).
const TokenPrefix = "ompsup_"

const (
	MinDuration   = 5 * time.Minute
	MaxDuration   = 7 * 24 * time.Hour
	DefaultNote   = ""
	maxActive     = 10
	maxNoteRunes  = 200
	touchInterval = time.Minute
	verifyCache   = 3 * time.Second
)

var (
	ErrInvalid = errors.New("supportaccess: invalid token")
	ErrExpired = errors.New("supportaccess: access expired")
	ErrRevoked = errors.New("supportaccess: access revoked")
	ErrTooMany = errors.New("supportaccess: too many active accesses")
	ErrBadTime = errors.New("supportaccess: duration out of range")
	ErrUnknown = errors.New("supportaccess: unknown access")
)

// Grant ist ein Support-Zugang (ohne Token).
type Grant struct {
	ID          string     `json:"id"`
	CreatedBy   string     `json:"createdBy"`
	Note        string     `json:"note,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	ExpiresAt   time.Time  `json:"expiresAt"`
	RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	FirstUsedAt *time.Time `json:"firstUsedAt,omitempty"`
	LastUsedAt  *time.Time `json:"lastUsedAt,omitempty"`
	// UseCount: Zahl der Anmeldungen mit diesem Zugang.
	UseCount int `json:"useCount"`
}

// Status: "active", "expired" oder "revoked".
func (g Grant) Status(now time.Time) string {
	switch {
	case g.RevokedAt != nil:
		return "revoked"
	case !now.Before(g.ExpiresAt):
		return "expired"
	}
	return "active"
}

// Store speichert die Zugänge.
type Store struct {
	db  *sql.DB
	now func() time.Time

	mu      sync.Mutex
	cache   map[string]cached // token_hash → Prüfergebnis (kurz, damit ein Widerruf schnell wirkt, aber nicht jede Anfrage die DB trifft)
	touched map[string]time.Time
}

type cached struct {
	g   Grant
	err error
	at  time.Time
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db, now: time.Now, cache: map[string]cached{}, touched: map[string]time.Time{}}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Create legt einen Zugang an und liefert das Token (nur jetzt im Klartext).
func (s *Store) Create(ctx context.Context, by, note string, d time.Duration) (Grant, string, error) {
	if d < MinDuration || d > MaxDuration {
		return Grant{}, "", ErrBadTime
	}
	if r := []rune(strings.TrimSpace(note)); len(r) > maxNoteRunes {
		note = string(r[:maxNoteRunes])
	}
	note = strings.TrimSpace(note)
	var active int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM support_access WHERE revoked_at IS NULL AND expires_at > now()`).Scan(&active); err != nil {
		return Grant{}, "", err
	}
	if active >= maxActive {
		return Grant{}, "", ErrTooMany
	}
	id, err := randomString(9)
	if err != nil {
		return Grant{}, "", err
	}
	secret, err := randomString(32)
	if err != nil {
		return Grant{}, "", err
	}
	token := TokenPrefix + id + "." + secret
	now := s.now().UTC()
	g := Grant{ID: id, CreatedBy: by, Note: note, CreatedAt: now, ExpiresAt: now.Add(d)}
	_, err = s.db.ExecContext(ctx, `INSERT INTO support_access (id, token_hash, created_by, note, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		g.ID, hashToken(token), by, note, g.CreatedAt, g.ExpiresAt)
	if err != nil {
		return Grant{}, "", err
	}
	return g, token, nil
}

const grantCols = `id, created_by, note, created_at, expires_at, revoked_at, first_used_at, last_used_at, use_count`

func scanGrant(row interface{ Scan(...any) error }) (Grant, error) {
	var g Grant
	var revoked, first, last sql.NullTime
	if err := row.Scan(&g.ID, &g.CreatedBy, &g.Note, &g.CreatedAt, &g.ExpiresAt, &revoked, &first, &last, &g.UseCount); err != nil {
		return Grant{}, err
	}
	if revoked.Valid {
		g.RevokedAt = &revoked.Time
	}
	if first.Valid {
		g.FirstUsedAt = &first.Time
	}
	if last.Valid {
		g.LastUsedAt = &last.Time
	}
	return g, nil
}

// List liefert die neuesten Zugänge (aktive, abgelaufene und widerrufene), neueste zuerst.
func (s *Store) List(ctx context.Context, limit int) ([]Grant, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+grantCols+` FROM support_access ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		g, err := scanGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// Revoke beendet einen Zugang sofort.
func (s *Store) Revoke(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE support_access SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	s.mu.Lock()
	s.cache = map[string]cached{} // der Widerruf gilt ab der nächsten Anfrage
	s.mu.Unlock()
	if n == 0 {
		var exists bool
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM support_access WHERE id = $1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrUnknown
		}
	}
	return nil
}

// Verify prüft ein Token: Form, Hash, Ablauf, Widerruf. Das Ergebnis wird wenige Sekunden zwischengespeichert.
func (s *Store) Verify(ctx context.Context, token string) (Grant, error) {
	if !strings.HasPrefix(token, TokenPrefix) || len(token) > 200 {
		return Grant{}, ErrInvalid
	}
	h := hashToken(token)
	now := s.now()
	s.mu.Lock()
	c, ok := s.cache[h]
	s.mu.Unlock()
	if ok && now.Sub(c.at) < verifyCache {
		return s.recheck(c.g, c.err, now)
	}
	g, err := scanGrant(s.db.QueryRowContext(ctx, `SELECT `+grantCols+` FROM support_access WHERE token_hash = $1`, h))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		g, err = Grant{}, ErrInvalid
	case err != nil:
		return Grant{}, err
	default:
		// Gleichlanger Vergleich des Hashs gegen Zeitkanäle (der Treffer kam über den Index, hier nur Absicherung).
		if subtle.ConstantTimeCompare([]byte(h), []byte(hashToken(token))) != 1 {
			g, err = Grant{}, ErrInvalid
		}
	}
	s.mu.Lock()
	s.cache[h] = cached{g: g, err: err, at: now}
	if len(s.cache) > 256 {
		s.cache = map[string]cached{h: s.cache[h]}
	}
	s.mu.Unlock()
	return s.recheck(g, err, now)
}

// recheck wertet Ablauf und Widerruf bei jeder Anfrage neu aus (auch aus dem Zwischenspeicher).
func (s *Store) recheck(g Grant, err error, now time.Time) (Grant, error) {
	if err != nil {
		return Grant{}, err
	}
	switch g.Status(now) {
	case "revoked":
		return g, ErrRevoked
	case "expired":
		return g, ErrExpired
	}
	return g, nil
}

// MarkLogin zählt eine Anmeldung mit diesem Zugang.
func (s *Store) MarkLogin(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE support_access SET use_count = use_count + 1, first_used_at = COALESCE(first_used_at, now()), last_used_at = now() WHERE id = $1`, id)
	return err
}

// Touch vermerkt die letzte Benutzung (höchstens einmal pro Minute und Zugang).
func (s *Store) Touch(ctx context.Context, id string) {
	now := s.now()
	s.mu.Lock()
	if last, ok := s.touched[id]; ok && now.Sub(last) < touchInterval {
		s.mu.Unlock()
		return
	}
	s.touched[id] = now
	s.mu.Unlock()
	_, _ = s.db.ExecContext(ctx, `UPDATE support_access SET last_used_at = now() WHERE id = $1`, id)
}

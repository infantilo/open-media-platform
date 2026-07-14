package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"

	"github.com/lib/pq"
)

// ErrUserExists wird geliefert, wenn CreateUser gegen einen bereits
// vergebenen Nutzernamen läuft.
var ErrUserExists = errors.New("auth: username already exists")

// Store persistiert Nutzerkonten in Postgres (users-Tabelle,
// db/migrations/0002_auth.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Count liefert die Anzahl angelegter Nutzer — 0 bedeutet "Bootstrap-
// Modus" (s. httpapi/auth_handlers.go): solange kein Nutzer existiert,
// ist die API offen, exakt das aus PIPELINE CONTROLLER übernommene
// Muster "Auth deaktivierbar solange kein Nutzer angelegt ist"
// (ARCHITECTURE.md §12).
func (s *Store) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// Create legt einen neuen Nutzer mit bereits gehashtem Passwort an.
func (s *Store) Create(ctx context.Context, username, passwordHash string) (User, error) {
	id, err := newID()
	if err != nil {
		return User{}, err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)`,
		id, username, passwordHash)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrUserExists
		}
		return User{}, err
	}
	return s.byUsername(ctx, username)
}

// ByUsername liefert den Nutzer mit dem gegebenen Namen (ok=false, wenn
// keiner existiert).
func (s *Store) ByUsername(ctx context.Context, username string) (User, bool, error) {
	u, err := s.byUsername(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	return u, true, nil
}

func (s *Store) byUsername(ctx context.Context, username string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at FROM users WHERE username = $1`, username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.CreatedAt)
	return u, err
}

// isUniqueViolation erkennt einen Postgres-Unique-Constraint-Verstoß
// (SQLSTATE 23505) am strukturierten *pq.Error statt an einem
// String-Grep über die Fehlermeldung.
func isUniqueViolation(err error) bool {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) {
		return pqErr.Code == "23505"
	}
	return false
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

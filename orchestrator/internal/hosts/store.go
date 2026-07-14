package hosts

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

// ErrInvalidToken wird geliefert, wenn ein Bootstrap-Token unbekannt,
// abgelaufen oder bereits verbraucht ist — bewusst ein einziger Fehler
// für alle drei Fälle (kein Orakel, das einem Angreifer verrät, welcher
// der drei Gründe zutrifft).
var ErrInvalidToken = errors.New("hosts: invalid or already-used bootstrap token")

// Store persistiert Hosts und Bootstrap-Tokens in Postgres
// (db/migrations/0003_hosts.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// CreateBootstrapToken erzeugt ein neues, einmaliges Token, gültig für
// ttl. Das Klartext-Token wird nur einmal zurückgegeben (nicht
// gespeichert, s. hosts.go-Paketkommentar) — verloren ist verloren, ein
// neues Token muss ausgestellt werden (kein Wiederherstellungspfad,
// gleiche Sicherheitsannahme wie bei einem Passwort).
func (s *Store) CreateBootstrapToken(createdBy string, ttl time.Duration) (token string, expiresAt time.Time, err error) {
	id, err := newID()
	if err != nil {
		return "", time.Time{}, err
	}
	token, err = newID()
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt = time.Now().Add(ttl)
	_, err = s.db.Exec(
		`INSERT INTO host_bootstrap_tokens (id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
		id, hashToken(token), createdBy, expiresAt)
	if err != nil {
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

// ConsumeBootstrapToken prüft token und markiert es — atomar in einer
// einzigen SQL-Anweisung — als verbraucht, sofern es existiert, noch
// nicht abgelaufen und noch nicht verbraucht ist. Der `WHERE
// used_at IS NULL`-Teil macht das race-sicher gegen zwei gleichzeitige
// Registrierungsversuche mit demselben Token (nur einer gewinnt das
// UPDATE).
func (s *Store) ConsumeBootstrapToken(token string) error {
	res, err := s.db.Exec(
		`UPDATE host_bootstrap_tokens SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		hashToken(token))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrInvalidToken
	}
	return nil
}

// CreateHost legt einen neu registrierten Host an.
func (s *Store) CreateHost(label, hostname string, capabilities []byte) (Host, error) {
	id, err := newID()
	if err != nil {
		return Host{}, err
	}
	if capabilities == nil {
		capabilities = []byte("{}")
	}
	var registeredAt time.Time
	err = s.db.QueryRow(
		`INSERT INTO hosts (id, label, hostname, capabilities) VALUES ($1, $2, $3, $4)
		 RETURNING registered_at`,
		id, label, hostname, capabilities,
	).Scan(&registeredAt)
	if err != nil {
		return Host{}, err
	}
	return Host{ID: id, Label: label, Hostname: hostname, Capabilities: capabilities, RegisteredAt: registeredAt}, nil
}

// ListHosts liefert alle registrierten Hosts, neueste zuerst.
func (s *Store) ListHosts() ([]Host, error) {
	rows, err := s.db.Query(`SELECT id, label, hostname, capabilities, registered_at FROM hosts ORDER BY registered_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	hosts := []Host{}
	for rows.Next() {
		var h Host
		if err := rows.Scan(&h.ID, &h.Label, &h.Hostname, &h.Capabilities, &h.RegisteredAt); err != nil {
			return nil, err
		}
		hosts = append(hosts, h)
	}
	return hosts, rows.Err()
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// Package alarmacks persistiert den geteilten Quittier-/Maskierstand der
// Alarme (Nachtrag 243). Alarme entstehen weiter in der UI aus den
// bestehenden Quellen (Instanzen, Hosts, Placement, Workflows) — dieser
// Store hält nur, WER WAS für WELCHEN Alarm-Zustand quittiert/maskiert
// hat, damit alle Operatoren denselben Stand sehen.
package alarmacks

import (
	"database/sql"
	"errors"
	"time"
)

const (
	ModeAck  = "ack"  // gesehen: bleibt sichtbar, zählt nicht mehr als laut
	ModeMask = "mask" // ausgeblendet aus Footer/Zähler
)

// Retention: Einträge, die länger als das zurückliegen, werden beim
// Auflisten weggeräumt (der zugehörige Alarm ist dann sicher längst
// erledigt oder hat einen neuen Fingerprint).
const Retention = 30 * 24 * time.Hour

var (
	ErrInvalid = errors.New("alarmacks: key, fingerprint and mode (ack|mask) required")
)

// Ack ist ein Quittier-/Maskiereintrag.
type Ack struct {
	Key         string     `json:"key"`
	Fingerprint string     `json:"fingerprint"`
	Mode        string     `json:"mode"`
	Comment     string     `json:"comment,omitempty"`
	Username    string     `json:"username"`
	CreatedAt   time.Time  `json:"createdAt"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
}

type Store struct {
	db *sql.DB
}

func NewStore(database *sql.DB) *Store { return &Store{db: database} }

// List liefert alle gültigen Einträge und räumt dabei abgelaufene sowie
// über die Retention hinaus alte auf (opportunistisch).
func (s *Store) List() ([]Ack, error) {
	if _, err := s.db.Exec(
		`DELETE FROM alarm_acks WHERE (expires_at IS NOT NULL AND expires_at <= now()) OR created_at < $1`,
		time.Now().Add(-Retention),
	); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT key, fingerprint, mode, comment, username, created_at, expires_at FROM alarm_acks ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Ack{}
	for rows.Next() {
		var a Ack
		var exp sql.NullTime
		if err := rows.Scan(&a.Key, &a.Fingerprint, &a.Mode, &a.Comment, &a.Username, &a.CreatedAt, &exp); err != nil {
			return nil, err
		}
		if exp.Valid {
			t := exp.Time
			a.ExpiresAt = &t
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Put setzt/ersetzt den Eintrag für a.Key. CreatedAt wird serverseitig
// gesetzt.
func (s *Store) Put(a Ack) error {
	if a.Key == "" || a.Fingerprint == "" || (a.Mode != ModeAck && a.Mode != ModeMask) {
		return ErrInvalid
	}
	_, err := s.db.Exec(`
		INSERT INTO alarm_acks (key, fingerprint, mode, comment, username, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, now(), $6)
		ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, mode = EXCLUDED.mode,
			comment = EXCLUDED.comment, username = EXCLUDED.username,
			created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
	`, a.Key, a.Fingerprint, a.Mode, a.Comment, a.Username, a.ExpiresAt)
	return err
}

// Delete entfernt den Eintrag (Wiederherstellen). Nicht vorhanden ist kein Fehler.
func (s *Store) Delete(key string) error {
	_, err := s.db.Exec(`DELETE FROM alarm_acks WHERE key = $1`, key)
	return err
}

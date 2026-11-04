// Package catalogdist verteilt importierte Container-Microservices auf Hosts (Kap. 85).
//
// Der Orchestrator baut aus Katalogeintrag und Image ein signiertes Bundle (update.WriteBundle), schickt jedem Ziel-Host
// ein signiertes NATS-Kommando mit Einmal-Token-Pfad und Prüfsumme; der Host-Agent lädt NUR vom eigenen Orchestrator,
// prüft Signatur (eigener Vertrauensanker) und Prüfsumme und entscheidet über Vertrauens-Erweiterungen selbst.
// Der Soll-Zustand liegt in Postgres (catalog_distribution), ein Abgleich unter runWhileLeader stellt ihn her.
package catalogdist

import (
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

// Zustände einer Zeile.
const (
	StatePending    = "pending"
	StateInstalling = "installing"
	StateOK         = "ok"
	StateFailed     = "failed"
	StateOffline    = "offline"
	StateRemoving   = "removing"

	DesiredPresent = "present"
	DesiredAbsent  = "absent"
)

// Row ist der Soll-/Ist-Zustand für (Typ, Version, Host).
type Row struct {
	Type      string    `json:"type"`
	Version   string    `json:"version"`
	HostID    string    `json:"hostId"`
	Desired   string    `json:"desired"`
	State     string    `json:"state"`
	Detail    string    `json:"detail,omitempty"`
	ImageID   string    `json:"imageId,omitempty"`
	Attempts  int       `json:"attempts"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Store liegt auf der migrierten Datenbankverbindung.
type Store struct{ db *sql.DB }

// NewStore erzeugt den Store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Key liefert den Verteilschlüssel; beim ersten Aufruf wird er erzeugt. Parallele Erzeuger (mehrere Mitglieder)
// einigen sich über die Datenbank: wer zuerst einfügt, gewinnt, alle lesen danach denselben Schlüssel.
func (s *Store) Key() (ed25519.PrivateKey, string, error) {
	read := func() (ed25519.PrivateKey, string, error) {
		var priv, pub string
		err := s.db.QueryRow(`SELECT private_key, public_key FROM catalog_dist_key WHERE id = 1`).Scan(&priv, &pub)
		if err != nil {
			return nil, "", err
		}
		raw, err := base64.StdEncoding.DecodeString(priv)
		if err != nil || len(raw) != ed25519.PrivateKeySize {
			return nil, "", errors.New("catalogdist: gespeicherter Verteilschlüssel ist beschädigt")
		}
		return ed25519.PrivateKey(raw), pub, nil
	}
	if p, pub, err := read(); err == nil {
		return p, pub, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, "", err
	}
	priv, pub, err := update.GenerateDistKey()
	if err != nil {
		return nil, "", err
	}
	if _, err := s.db.Exec(`INSERT INTO catalog_dist_key (id, private_key, public_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
		base64.StdEncoding.EncodeToString(priv), pub); err != nil {
		return nil, "", err
	}
	return read()
}

// Upsert setzt den Soll-Zustand und stellt die Zeile auf „pending“ (Versuche zurück).
func (s *Store) Upsert(typ, version, hostID, desired string) error {
	_, err := s.db.Exec(`
		INSERT INTO catalog_distribution (type, version, host_id, desired, state, detail, attempts, updated_at)
		VALUES ($1, $2, $3, $4, 'pending', '', 0, now())
		ON CONFLICT (type, version, host_id) DO UPDATE
		SET desired = EXCLUDED.desired, state = 'pending', detail = '', attempts = 0, updated_at = now()`,
		typ, version, hostID, desired)
	return err
}

// Set aktualisiert Zustand/Detail (und zählt Versuche bei Fehlern).
func (s *Store) Set(typ, version, hostID, state, detail, imageID string, failed bool) error {
	inc := 0
	if failed {
		inc = 1
	}
	_, err := s.db.Exec(`
		UPDATE catalog_distribution SET state = $4, detail = $5, image_id = CASE WHEN $6 <> '' THEN $6 ELSE image_id END,
		       attempts = CASE WHEN $4 = 'ok' THEN 0 ELSE attempts + $7 END, updated_at = now()
		WHERE type = $1 AND version = $2 AND host_id = $3`,
		typ, version, hostID, state, detail, imageID, inc)
	return err
}

// Delete entfernt eine Zeile.
func (s *Store) Delete(typ, version, hostID string) error {
	_, err := s.db.Exec(`DELETE FROM catalog_distribution WHERE type = $1 AND version = $2 AND host_id = $3`, typ, version, hostID)
	return err
}

// List liefert alle Zeilen.
func (s *Store) List() ([]Row, error) {
	rows, err := s.db.Query(`SELECT type, version, host_id, desired, state, detail, image_id, attempts, updated_at
		FROM catalog_distribution ORDER BY type, version, host_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.Type, &r.Version, &r.HostID, &r.Desired, &r.State, &r.Detail, &r.ImageID, &r.Attempts, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

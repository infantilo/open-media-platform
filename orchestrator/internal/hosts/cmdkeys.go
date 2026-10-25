package hosts

import (
	"database/sql"
	"errors"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// CommandKey liefert den Kommandoschlüssel des Hosts (legt ihn beim ersten Aufruf an) und ob der Host-Agent ihn schon kennt.
func (s *Store) CommandKey(hostID string) (key string, provisioned bool, err error) {
	fresh, err := jobwire.NewKey()
	if err != nil {
		return "", false, err
	}
	if _, err = s.db.Exec(`INSERT INTO host_command_keys (host_id, key) VALUES ($1, $2) ON CONFLICT (host_id) DO NOTHING`, hostID, fresh); err != nil {
		return "", false, err
	}
	var at sql.NullTime
	if err = s.db.QueryRow(`SELECT key, provisioned_at FROM host_command_keys WHERE host_id = $1`, hostID).Scan(&key, &at); err != nil {
		return "", false, err
	}
	return key, at.Valid, nil
}

// MarkProvisioned vermerkt, dass der Host-Agent den Schlüssel kennt.
func (s *Store) MarkProvisioned(hostID string) error {
	_, err := s.db.Exec(`UPDATE host_command_keys SET provisioned_at = now() WHERE host_id = $1 AND provisioned_at IS NULL`, hostID)
	return err
}

// IssueCommandKey legt den Schlüssel für einen frisch registrierten Host an, der ihn mit der Registrierungsantwort erhält
// (gilt damit als bereitgestellt).
func (s *Store) IssueCommandKey(hostID string) (string, error) {
	key, _, err := s.CommandKey(hostID)
	if err != nil {
		return "", err
	}
	if err := s.MarkProvisioned(hostID); err != nil {
		return "", err
	}
	return key, nil
}

// NextKey liefert den noch nicht bestätigten Folgeschlüssel ("" = keiner).
func (s *Store) NextKey(hostID string) (string, error) {
	var k sql.NullString
	err := s.db.QueryRow(`SELECT next_key FROM host_command_keys WHERE host_id = $1`, hostID).Scan(&k)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return k.String, err
}

// SetNextKey merkt den Folgeschlüssel, BEVOR er an den Agent geht (bricht der Orchestrator danach ab, kennt er ihn noch).
func (s *Store) SetNextKey(hostID, key string) error {
	_, err := s.db.Exec(`UPDATE host_command_keys SET next_key = $2 WHERE host_id = $1`, hostID, key)
	return err
}

// PromoteNextKey macht den Folgeschlüssel zum gültigen Schlüssel (der Agent hat ihn übernommen).
func (s *Store) PromoteNextKey(hostID string) error {
	_, err := s.db.Exec(`UPDATE host_command_keys SET key = next_key, next_key = NULL WHERE host_id = $1 AND next_key IS NOT NULL`, hostID)
	return err
}

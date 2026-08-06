package launcher

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// ErrNodeSettingsNotFound wird von NodeSettingsStore.Get geliefert, wenn
// für den angefragten Node-Typ noch kein Blob gespeichert wurde — der
// Aufrufer (i. d. R. ein Handler mit eingebauten Default-Werten für
// genau diesen Node-Typ) entscheidet, ob das ein Fehler oder ein
// "liefere die Defaults"-Fall ist.
var ErrNodeSettingsNotFound = errors.New("launcher: node settings not found")

// ErrNodeSettingsInvalidJSON wird von NodeSettingsStore.Put geliefert,
// wenn data kein syntaktisch gültiges JSON ist.
var ErrNodeSettingsInvalidJSON = errors.New("launcher: node settings data is not valid JSON")

// NodeSettingsStore liest/schreibt Node-Typ-weite (nicht Instanz-weite)
// Einstellungs-Blobs in der `node_type_settings`-Tabelle
// (internal/db/migrations/0013_node_type_settings.sql) — ein Blob pro
// Node-Typ, gleiches Muster wie CatalogStore. Bewusst generisch: kennt
// nur "irgendein JSON-Blob unter diesem Node-Typ-Namen", jede
// typspezifische Validierung/Bedeutung gehört in die jeweilige
// httpapi-Handler-Schicht (s. node_settings_handlers.go), nicht hierher
// — künftige Node-Typen mit eigenen Einstellungen brauchen dafür keine
// neue Migration/Store, nur einen neuen Handler.
type NodeSettingsStore struct {
	db *sql.DB
}

// NewNodeSettingsStore erstellt einen Store auf der gegebenen, bereits
// migrierten Datenbankverbindung.
func NewNodeSettingsStore(database *sql.DB) *NodeSettingsStore {
	return &NodeSettingsStore{db: database}
}

// Get liest den zuletzt gespeicherten Blob für nodeType. Liefert
// ErrNodeSettingsNotFound, wenn noch nie gespeichert wurde.
func (s *NodeSettingsStore) Get(nodeType string) (json.RawMessage, error) {
	var data json.RawMessage
	err := s.db.QueryRow(`SELECT data FROM node_type_settings WHERE node_type = $1`, nodeType).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNodeSettingsNotFound
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

// Put speichert (oder überschreibt) den Blob für nodeType. Der
// Aufrufer ist für die Validierung des Inhalts verantwortlich (s.
// Moduldoku) — hier wird nur auf syntaktisch gültiges JSON geprüft.
func (s *NodeSettingsStore) Put(nodeType string, data json.RawMessage) error {
	if !json.Valid(data) {
		return ErrNodeSettingsInvalidJSON
	}
	_, err := s.db.Exec(`
		INSERT INTO node_type_settings (node_type, data, updated_at) VALUES ($1, $2, now())
		ON CONFLICT (node_type) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
	`, nodeType, []byte(data))
	return err
}

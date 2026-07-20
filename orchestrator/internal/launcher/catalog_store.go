package launcher

import (
	"database/sql"
	"encoding/json"
)

// CatalogStore liest/schreibt importierte Katalog-Einträge in der
// `catalog_entries`-Tabelle (internal/db/migrations/0009_catalog_
// entries.sql, §17 Teil 4) — gleiches Blob-pro-Zeile-Muster wie
// launcher.Store (Instanzen). Nur importierte (per `POST /api/v1/
// catalog` hinzugefügte) Einträge landen hier — die statischen
// Einträge aus deploy/catalog.json bleiben unverändert eine Datei,
// s. Launcher.Catalog()-Doku.
type CatalogStore struct {
	db *sql.DB
}

// NewCatalogStore erstellt einen Store auf der gegebenen, bereits
// migrierten Datenbankverbindung.
func NewCatalogStore(database *sql.DB) *CatalogStore {
	return &CatalogStore{db: database}
}

// Put speichert (oder überschreibt) einen importierten Katalog-Eintrag.
func (s *CatalogStore) Put(entry CatalogEntry) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO catalog_entries (type, data) VALUES ($1, $2)
		ON CONFLICT (type) DO UPDATE SET data = EXCLUDED.data
	`, entry.Type, data)
	return err
}

// Delete entfernt einen importierten Katalog-Eintrag. Kein Fehler, wenn
// er nicht existiert (idempotent, gleiches Muster wie Store.Delete).
func (s *CatalogStore) Delete(entryType string) error {
	_, err := s.db.Exec(`DELETE FROM catalog_entries WHERE type = $1`, entryType)
	return err
}

// List liefert alle importierten Katalog-Einträge (keine Reihenfolge-
// Garantie).
func (s *CatalogStore) List() ([]CatalogEntry, error) {
	rows, err := s.db.Query(`SELECT data FROM catalog_entries`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CatalogEntry{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var entry CatalogEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			continue
		}
		out = append(out, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

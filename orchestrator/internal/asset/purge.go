package asset

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"
)

// Aufräumen gelöschter Assets: „deleted“ ist nur eine Markierung (die Zeile, ihre Versionen und Darstellungen bleiben, damit
// ein Versehen rückgängig zu machen ist). PurgeDeleted entfernt sie endgültig. Abhängige Module (Eingang/Review mit eigenen Tabellen
// und Proxy-Dateien) räumen über einen Haken im selben Schritt mit auf — sonst blieben Waisen zurück.

// PurgeHook läuft in der Löschtransaktion; die zurückgegebene Funktion (darf nil sein) läuft erst nach dem Commit
// (z. B. Dateien löschen, die sich nicht zurückrollen lassen).
type PurgeHook func(tx *sql.Tx, assetIDs []string) (afterCommit func(), err error)

var (
	hookMu sync.Mutex
	hooks  = map[string]PurgeHook{}
)

// RegisterPurgeHook trägt einen Haken ein; gleicher Name ersetzt den früheren (ein Modul kann neu eingehängt werden).
func RegisterPurgeHook(name string, h PurgeHook) {
	hookMu.Lock()
	defer hookMu.Unlock()
	hooks[name] = h
}

// PurgeDeleted entfernt alle Assets im Zustand „deleted“, die seit mindestens `olderThan` so markiert sind (0 = alle), samt
// Versionen, Darstellungen, Sammlungs-Mitgliedschaften und Beziehungen (Datenbank-Kaskade) und den Daten der eingehängten Module.
// Liefert die IDs der entfernten Assets.
func (s *Store) PurgeDeleted(olderThan time.Duration) ([]string, error) {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `SELECT id FROM assets WHERE status = $1 AND updated_at <= now() - make_interval(secs => $2) ORDER BY id FOR UPDATE`,
		StatusDeleted, olderThan.Seconds())
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []string{}, nil
	}

	hookMu.Lock()
	snapshot := make([]PurgeHook, 0, len(hooks))
	for _, h := range hooks {
		snapshot = append(snapshot, h)
	}
	hookMu.Unlock()
	var after []func()
	for _, h := range snapshot {
		f, err := h(tx, ids)
		if err != nil {
			return nil, fmt.Errorf("asset: aufräumen: %w", err)
		}
		if f != nil {
			after = append(after, f)
		}
	}
	for _, id := range ids {
		if err := s.enqueueEvent(tx, id, "purged", map[string]string{"assetId": id}); err != nil {
			return nil, err
		}
	}
	// Die Asset-Zeile verweist auf ihre aktuelle Version (ohne Kaskade); erst lösen, dann die Zeile samt Versionen entfernen.
	if _, err := tx.ExecContext(ctx, `UPDATE assets SET current_version_id = NULL WHERE id = ANY($1)`, ids); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM assets WHERE id = ANY($1)`, ids); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for _, f := range after {
		f()
	}
	return ids, nil
}

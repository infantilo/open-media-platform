// Package fsutil enthält kleine Dateisystem-Helfer.
package fsutil

import (
	"os"
	"path/filepath"
)

// WriteFileAtomic ersetzt path in einem Schritt: temporäre Datei im selben Verzeichnis, fsync, Umbenennen, fsync des
// Verzeichnisses. Nach einem Absturz oder Stromausfall steht dort der alte oder der neue Inhalt, nie ein Teil davon.
// Ein Symlink bleibt erhalten (ersetzt wird sein Ziel).
func WriteFileAtomic(path string, data []byte, perm os.FileMode) (err error) {
	if target, e := filepath.EvalSymlinks(path); e == nil {
		path = target
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if err = f.Chmod(perm); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	// Best effort: nicht jedes Dateisystem erlaubt fsync auf Verzeichnisse; die Datei ist schon ersetzt.
	if d, e := os.Open(dir); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

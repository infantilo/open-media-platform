package backup

// Schlüsselmaterial in der Sicherung (Audit 2026-10-23 M8): die Datenbanksicherung enthält weder den Update-Signierschlüssel, die mTLS-CA noch
// die Dateigeheimnisse neben dem JWT-Geheimnis — wer die Maschine verliert, könnte weder Updates signieren noch Zertifikate ausstellen.
// Das Bündel ist ein tar.gz der Dateien, mit AES-256-GCM verschlüsselt (Schlüssel aus einer Passphrase per PBKDF2-SHA256); ohne
// Passphrase (OMP_BACKUP_PASSPHRASE oder …_FILE) wird kein Bündel erstellt — Schlüssel im Klartext neben die Sicherung zu legen wäre schlechter als
// sie gar nicht zu sichern.
//
// Aufbau der Datei: "OMPKEY1\n" | Salz (16) | Nonce (12) | Chiffretext+Tag.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	keyMagic         = "OMPKEY1\n"
	pbkdf2Iterations = 600_000
	maxKeyFile       = 1 << 20
	maxKeyBundle     = 20 << 20
)

// expandKeyPaths löst Verzeichnisse rekursiv auf; fehlende Einträge werden übersprungen (nicht jede Installation hat jedes Geheimnis).
func expandKeyPaths(paths []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(abs)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, err
		}
		add := func(f string) {
			if !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
		if !info.IsDir() {
			add(abs)
			continue
		}
		err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // unlesbare Teile überspringen
			}
			if d.Type().IsRegular() {
				add(path)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(out)
	return out, nil
}

// BundleKeys packt die Dateien (Verzeichnisse rekursiv) und verschlüsselt sie. Liefert (nil, 0, nil), wenn nichts zu sichern ist.
func BundleKeys(paths []string, passphrase string) ([]byte, int, error) {
	if passphrase == "" {
		return nil, 0, errors.New("keine Passphrase für das Schlüsselbündel")
	}
	files, err := expandKeyPaths(paths)
	if err != nil {
		return nil, 0, err
	}
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	total, n := 0, 0
	for _, f := range files {
		info, err := os.Stat(f)
		if err != nil || info.Size() > maxKeyFile {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		total += len(data)
		if total > maxKeyBundle {
			return nil, 0, fmt.Errorf("Schlüsselbündel größer als %d MiB", maxKeyBundle>>20)
		}
		hdr := &tar.Header{Name: strings.TrimPrefix(filepath.ToSlash(f), "/"), Mode: int64(info.Mode().Perm()), Size: int64(len(data)), ModTime: info.ModTime()}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, 0, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, 0, err
		}
		n++
	}
	if err := tw.Close(); err != nil {
		return nil, 0, err
	}
	if err := gz.Close(); err != nil {
		return nil, 0, err
	}
	if n == 0 {
		return nil, 0, nil
	}
	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return nil, 0, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, 0, err
	}
	aead, err := newAEAD(passphrase, salt)
	if err != nil {
		return nil, 0, err
	}
	out := append([]byte(keyMagic), salt...)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, raw.Bytes(), []byte(keyMagic))
	return out, n, nil
}

func newAEAD(passphrase string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, pbkdf2Iterations, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// OpenKeys entschlüsselt ein Bündel und liefert Name (ohne führenden "/") → Inhalt. Falsche Passphrase und beschädigte Datei sind nicht zu unterscheiden.
func OpenKeys(data []byte, passphrase string) (map[string][]byte, error) {
	if len(data) < len(keyMagic)+16+12+16 || string(data[:len(keyMagic)]) != keyMagic {
		return nil, errors.New("kein Schlüsselbündel")
	}
	rest := data[len(keyMagic):]
	salt, nonce, ct := rest[:16], rest[16:28], rest[28:]
	aead, err := newAEAD(passphrase, salt)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, nonce, ct, []byte(keyMagic))
	if err != nil {
		return nil, errors.New("Passphrase falsch oder Bündel beschädigt")
	}
	gr, err := gzip.NewReader(bytes.NewReader(plain))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gr)
	out := map[string][]byte{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(tr, maxKeyFile+1))
		if err != nil {
			return nil, err
		}
		out[h.Name] = b
	}
}

// keysName: Dateiname des Bündels zu einer Sicherung ("omp-X.sql.gz" → "omp-X.keys.enc").
func keysName(dump string) string { return strings.TrimSuffix(dump, ".sql.gz") + ".keys.enc" }

// copyAtomic kopiert src nach dir/name (temporär + Umbenennen).
func copyAtomic(src, dir, name string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := filepath.Join(dir, name+".tmp")
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, name))
}

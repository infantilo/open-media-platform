package update

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

// BuildFile ist eine Datei, die in ein Paket soll.
type BuildFile struct {
	ID     string // Komponenten-ID
	Source string // lokaler Pfad
	Path   string // Pfad im Archiv
	Target string // Ziel (CheckTarget)
}

// Build schreibt ein Paket nach dst. m liefert Version/Arch/…; Components
// werden aus files berechnet (SHA-256). Mit priv != nil wird signiert.
func Build(dst string, m Manifest, priv ed25519.PrivateKey, files []BuildFile) error {
	m.SchemaVersion = SchemaVersion
	m.Components = nil
	for _, bf := range files {
		sum, err := fileSHA256(bf.Source)
		if err != nil {
			return err
		}
		m.Components = append(m.Components, Component{ID: bf.ID, Path: bf.Path, SHA256: sum, Target: bf.Target})
	}
	if m.BuiltAt == "" {
		m.BuiltAt = time.Now().UTC().Format(time.RFC3339)
	}
	manifest, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if _, err := ParseManifest(manifest); err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	fail := func(err error) error {
		_ = tw.Close()
		_ = gz.Close()
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	put := func(name string, data []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	if err := put(ManifestName, manifest); err != nil {
		return fail(err)
	}
	if priv != nil {
		if err := put(SignatureName, Sign(priv, manifest)); err != nil {
			return fail(err)
		}
	}
	for _, bf := range files {
		src, err := os.Open(bf.Source)
		if err != nil {
			return fail(err)
		}
		st, err := src.Stat()
		if err != nil {
			src.Close()
			return fail(err)
		}
		if err := tw.WriteHeader(&tar.Header{Name: bf.Path, Mode: 0o644, Size: st.Size(), Typeflag: tar.TypeReg}); err != nil {
			src.Close()
			return fail(err)
		}
		_, err = io.Copy(tw, src)
		src.Close()
		if err != nil {
			return fail(fmt.Errorf("%s: %w", bf.Source, err))
		}
	}
	if err := tw.Close(); err != nil {
		return fail(err)
	}
	if err := gz.Close(); err != nil {
		return fail(err)
	}
	return out.Close()
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

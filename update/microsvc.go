package update

// Microservice-Bundle (Kap. 85): ein unkomprimiertes tar mit
//   manifest.json  — Typ, Version, Katalogeintrag, Image-Name, Image-ID, SHA-256 des Image-Archivs
//   manifest.sig   — Ed25519-Signatur (Base64) über manifest.json, Schlüssel = Verteilschlüssel des Clusters (E1)
//   image.tar      — `podman save`-Archiv
// Der Host-Agent prüft Signatur gegen seinen EIGENEN Vertrauensanker, danach die SHA-256 des Image-Archivs gegen das
// signierte Manifest, erst dann `podman load`.

import (
	"archive/tar"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// BundleFormat kennzeichnet das Manifest-Format.
const BundleFormat = "omp-microservice/1"

const (
	bundleManifestName = "manifest.json"
	bundleSigName      = "manifest.sig"
	bundleImageName    = "image.tar"
	maxBundleManifest  = 1 << 20
)

// BundleManifest ist der signierte Teil eines Bundles.
type BundleManifest struct {
	Format  string `json:"format"`
	Type    string `json:"type"`
	Version string `json:"version"`
	Label   string `json:"label,omitempty"`
	// Image: Name, unter dem der Katalogeintrag das Image startet (Referenz nach `podman load`).
	Image string `json:"image"`
	// ImageID: sha256:… des Images (podman image inspect), nach dem Laden gegenzuprüfen.
	ImageID string `json:"imageId"`
	// ImageSHA256: SHA-256 (hex) von image.tar.
	ImageSHA256 string `json:"imageSha256"`
	ImageSize   int64  `json:"imageSize"`
	// Entry: der Katalogeintrag des Orchestrators (JSON, unverändert); der Agent übernimmt nur, was er versteht UND erlaubt.
	Entry     json.RawMessage `json:"entry"`
	CreatedAt time.Time       `json:"createdAt"`
}

var bundleNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidBundleName: Typ- und Versionsname dürfen nur sichere Zeichen enthalten (sie werden zu Dateinamen).
func ValidBundleName(s string) bool { return bundleNamePattern.MatchString(s) }

// Validate prüft das Manifest auf Vollständigkeit und sichere Namen.
func (m BundleManifest) Validate() error {
	if m.Format != BundleFormat {
		return fmt.Errorf("bundle: unbekanntes Format %q", m.Format)
	}
	if !ValidBundleName(m.Type) || !ValidBundleName(m.Version) {
		return errors.New("bundle: Typ/Version enthalten unzulässige Zeichen")
	}
	if m.Image == "" || m.ImageSHA256 == "" || len(m.Entry) == 0 {
		return errors.New("bundle: Manifest unvollständig (image/imageSha256/entry)")
	}
	return nil
}

// WriteBundle schreibt das Bundle atomar nach dst (image = Pfad zu image.tar) und liefert die SHA-256 des Bundles.
func WriteBundle(dst string, m BundleManifest, priv ed25519.PrivateKey, imagePath string) (string, error) {
	if err := m.Validate(); err != nil && !strings.Contains(err.Error(), "imageSha256") {
		return "", err
	}
	imgSum, imgSize, err := fileSumSize(imagePath)
	if err != nil {
		return "", err
	}
	m.ImageSHA256, m.ImageSize = imgSum, imgSize
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	if err := m.Validate(); err != nil {
		return "", err
	}
	mj, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	tmp := dst + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	h := sha256.New()
	tw := tar.NewWriter(io.MultiWriter(f, h))
	put := func(name string, data []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	if err := put(bundleManifestName, mj); err != nil {
		f.Close()
		return "", err
	}
	if err := put(bundleSigName, Sign(priv, mj)); err != nil {
		f.Close()
		return "", err
	}
	img, err := os.Open(imagePath)
	if err != nil {
		f.Close()
		return "", err
	}
	if err := tw.WriteHeader(&tar.Header{Name: bundleImageName, Mode: 0o600, Size: imgSize}); err != nil {
		img.Close()
		f.Close()
		return "", err
	}
	if _, err := io.Copy(tw, img); err != nil {
		img.Close()
		f.Close()
		return "", err
	}
	img.Close()
	if err := tw.Close(); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileSumSize(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// OpenBundle prüft ein Bundle vollständig und extrahiert image.tar nach imageDst:
// Struktur (nur die drei erwarteten Dateien), Signatur gegen trusted, SHA-256 des Image-Archivs gegen das Manifest.
func OpenBundle(path string, trusted []ed25519.PublicKey, imageDst string) (BundleManifest, string, error) {
	var m BundleManifest
	f, err := os.Open(path)
	if err != nil {
		return m, "", err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	var manifest, sig []byte
	imageDone := false
	var imgSum string
	for {
		hd, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return m, "", fmt.Errorf("bundle: %w", err)
		}
		switch hd.Name {
		case bundleManifestName, bundleSigName:
			if hd.Size > maxBundleManifest {
				return m, "", errors.New("bundle: Manifest zu groß")
			}
			b, err := io.ReadAll(io.LimitReader(tr, maxBundleManifest))
			if err != nil {
				return m, "", err
			}
			if hd.Name == bundleManifestName {
				manifest = b
			} else {
				sig = b
			}
		case bundleImageName:
			// Das Image kommt im tar nach Manifest und Signatur; ohne geprüftes Manifest wird nichts extrahiert.
			if manifest == nil || sig == nil {
				return m, "", errors.New("bundle: Reihenfolge ungültig (Manifest und Signatur müssen vor dem Image stehen)")
			}
			if _, ok := VerifySignature(manifest, sig, trusted); !ok {
				return m, "", errors.New("bundle: Signatur ungültig oder Schlüssel nicht vertrauenswürdig")
			}
			if err := os.MkdirAll(filepath.Dir(imageDst), 0o750); err != nil {
				return m, "", err
			}
			out, err := os.OpenFile(imageDst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return m, "", err
			}
			h := sha256.New()
			_, cerr := io.Copy(io.MultiWriter(out, h), tr)
			if e2 := out.Close(); cerr == nil {
				cerr = e2
			}
			if cerr != nil {
				os.Remove(imageDst)
				return m, "", cerr
			}
			imgSum = hex.EncodeToString(h.Sum(nil))
			imageDone = true
		default:
			return m, "", fmt.Errorf("bundle: unerwartete Datei %q", hd.Name)
		}
	}
	if manifest == nil || sig == nil || !imageDone {
		return m, "", errors.New("bundle: unvollständig")
	}
	if err := json.Unmarshal(manifest, &m); err != nil {
		os.Remove(imageDst)
		return m, "", fmt.Errorf("bundle: Manifest: %w", err)
	}
	if err := m.Validate(); err != nil {
		os.Remove(imageDst)
		return m, "", err
	}
	if imgSum != m.ImageSHA256 {
		os.Remove(imageDst)
		return BundleManifest{}, "", errors.New("bundle: Image-Archiv passt nicht zur signierten Prüfsumme")
	}
	return m, imgSum, nil
}

// GenerateDistKey erzeugt ein Ed25519-Schlüsselpaar (Verteilschlüssel); Rückgabe: privater Schlüssel, öffentlicher Schlüssel als Base64-Zeile.
func GenerateDistKey() (ed25519.PrivateKey, string, error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, "", err
	}
	return priv, EncodePublicKey(pub), nil
}

// EncodePublicKey liefert die Base64-Zeile eines öffentlichen Schlüssels (Format von ParsePublicKeys).
func EncodePublicKey(pub ed25519.PublicKey) string {
	return base64Std(pub)
}

func base64Std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

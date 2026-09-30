// Package update beschreibt, prüft und entpackt OMP-Update-Pakete
// (docs/ENTWURF-SYSTEM-UPDATE.md). Gemeinsam genutzt von Orchestrator
// (Upload/Vorprüfung), Supervisor (Anwenden, prüft ERNEUT — vertraut dem
// Orchestrator nicht blind, der ja gerade ersetzt wird) und
// tools/update-bundle (Paket bauen/signieren). Bewusst ein eigenes,
// abhängigkeitsfreies Modul, damit die drei Prozesse dieselbe
// Prüflogik teilen statt sie zu duplizieren.
//
// Format: `.tar.gz` mit `manifest.json`, `manifest.sig` (Ed25519 über die
// rohen Bytes von manifest.json) und den Komponentendateien. Jede
// Komponente steht mit Pfad im Archiv, SHA-256 und Ziel im Manifest; ein
// Archiv mit nicht gelisteten Dateien, Symlinks, absoluten/`..`-Pfaden
// oder abweichender Prüfsumme wird abgelehnt.
package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
)

const (
	ManifestName  = "manifest.json"
	SignatureName = "manifest.sig"
	// SchemaVersion ist die einzige unterstützte Manifest-Version.
	SchemaVersion = 1

	// MaxFileBytes begrenzt jede einzelne Datei im Archiv (Schutz vor
	// Archivbomben), MaxManifestBytes das Manifest selbst.
	MaxFileBytes     = 2 << 30
	MaxManifestBytes = 1 << 20
	maxEntries       = 4096
)

// Component ist eine Datei des Pakets.
type Component struct {
	// ID ist ein frei wählbarer, im Paket eindeutiger Name (nur Anzeige).
	ID string `json:"id"`
	// Path: Pfad der Datei IM Archiv.
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	// Target: erlaubtes Ziel, s. CheckTarget.
	Target string `json:"target"`
}

// Manifest beschreibt ein Update.
type Manifest struct {
	SchemaVersion  int         `json:"schemaVersion"`
	Version        string      `json:"version"`
	GitCommit      string      `json:"gitCommit,omitempty"`
	BuiltAt        string      `json:"builtAt,omitempty"`
	Arch           string      `json:"arch"`
	MinFromVersion string      `json:"minFromVersion,omitempty"`
	Migrations     []string    `json:"migrations,omitempty"`
	Notes          string      `json:"notes,omitempty"`
	Components     []Component `json:"components"`
}

// Package ist ein vollständig geprüftes Paket.
type Package struct {
	Manifest Manifest
	// Signed: die Signatur passt zu einem vertrauenswürdigen Schlüssel.
	Signed bool
	// KeyID: Kurzkennung (SHA-256-Präfix) des passenden Schlüssels.
	KeyID string
	// SHA256 des gesamten Archivs (Hex).
	SHA256 string
	Size   int64
}

// Options steuert die Prüfung.
type Options struct {
	// Trusted sind die vertrauenswürdigen Ed25519-Public-Keys.
	Trusted []ed25519.PublicKey
	// AllowUnsigned erlaubt Pakete OHNE gültige Signatur (nur Entwicklung).
	AllowUnsigned bool
	// Arch ist die erwartete Architektur ("linux/amd64"); leer = nicht prüfen.
	Arch string
}

var (
	ErrNoManifest   = errors.New("update: manifest.json fehlt")
	ErrBadSignature = errors.New("update: Signatur ungültig oder von keinem vertrauenswürdigen Schlüssel")
	ErrUnsigned     = errors.New("update: Paket ist nicht signiert")
)

var (
	nodeName    = regexp.MustCompile(`^omp-[a-z0-9][a-z0-9-]*$`)
	hexSHA256   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionExpr = regexp.MustCompile(`^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$`)
)

// FixedTargets sind die festen Binärziele relativ zum Installationsverzeichnis.
var FixedTargets = map[string]bool{
	"bin/omp-orchestrator": true,
	"bin/omp-supervisor":   true,
	"bin/omp-host-agent":   true,
}

// CheckTarget prüft ein Ziel: ein festes Binärziel, eine Datei unter
// `ui/dist/` oder `node:<omp-name>` (das die Installation über den
// Katalog auf den tatsächlichen Pfad abbildet). Alles andere — auch
// `..`, absolute Pfade, Backslashes — ist ungültig.
func CheckTarget(target string) error {
	if FixedTargets[target] {
		return nil
	}
	if name, ok := strings.CutPrefix(target, "node:"); ok {
		if !nodeName.MatchString(name) {
			return fmt.Errorf("update: ungültiger Node-Name %q", name)
		}
		return nil
	}
	if rest, ok := strings.CutPrefix(target, "ui/dist/"); ok {
		if rest == "" || !safeRel(target) {
			return fmt.Errorf("update: ungültiges UI-Ziel %q", target)
		}
		return nil
	}
	return fmt.Errorf("update: Ziel %q nicht erlaubt", target)
}

// safeRel: sauberer relativer Pfad ohne `..`, Backslash, führenden Slash.
func safeRel(p string) bool {
	if p == "" || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") {
		return false
	}
	return path.Clean(p) == p && p != "." && !strings.HasPrefix(p, "../") && !strings.Contains(p, "/../")
}

// IsExecutableTarget: Binärziele bekommen Modus 0755, alles andere 0644.
func IsExecutableTarget(target string) bool {
	return FixedTargets[target] || strings.HasPrefix(target, "node:")
}

// ParseManifest liest und validiert ein Manifest (ohne Archiv).
func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("update: manifest.json ungültig: %w", err)
	}
	if m.SchemaVersion != SchemaVersion {
		return m, fmt.Errorf("update: schemaVersion %d nicht unterstützt", m.SchemaVersion)
	}
	if !versionExpr.MatchString(m.Version) {
		return m, fmt.Errorf("update: ungültige Version %q", m.Version)
	}
	if m.MinFromVersion != "" && !versionExpr.MatchString(m.MinFromVersion) {
		return m, fmt.Errorf("update: ungültige minFromVersion %q", m.MinFromVersion)
	}
	if len(m.Components) == 0 {
		return m, errors.New("update: keine Komponenten im Manifest")
	}
	seenID, seenPath, seenTarget := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, c := range m.Components {
		if c.ID == "" || seenID[c.ID] {
			return m, fmt.Errorf("update: Komponenten-ID %q leer oder doppelt", c.ID)
		}
		seenID[c.ID] = true
		if !safeRel(c.Path) || c.Path == ManifestName || c.Path == SignatureName {
			return m, fmt.Errorf("update: ungültiger Archivpfad %q", c.Path)
		}
		if seenPath[c.Path] {
			return m, fmt.Errorf("update: Archivpfad %q doppelt", c.Path)
		}
		seenPath[c.Path] = true
		if !hexSHA256.MatchString(c.SHA256) {
			return m, fmt.Errorf("update: Komponente %q: sha256 ungültig", c.ID)
		}
		if err := CheckTarget(c.Target); err != nil {
			return m, err
		}
		if seenTarget[c.Target] {
			return m, fmt.Errorf("update: Ziel %q doppelt", c.Target)
		}
		seenTarget[c.Target] = true
	}
	return m, nil
}

// ReadPackage prüft das Archiv unter filePath vollständig (Struktur,
// Prüfsummen, Signatur) und liefert das Ergebnis. Keine Datei wird
// entpackt.
func ReadPackage(filePath string, opts Options) (*Package, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}

	whole := sha256.New()
	tee := io.TeeReader(f, whole)
	gz, err := gzip.NewReader(tee)
	if err != nil {
		return nil, fmt.Errorf("update: kein gzip-Archiv: %w", err)
	}
	tr := tar.NewReader(gz)

	var manifestBytes, sigBytes []byte
	sums := map[string]string{}
	entries := 0
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("update: Archiv beschädigt: %w", err)
		}
		entries++
		if entries > maxEntries {
			return nil, errors.New("update: zu viele Archiv-Einträge")
		}
		switch h.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		default:
			return nil, fmt.Errorf("update: Archiv-Eintrag %q hat unzulässigen Typ (nur reguläre Dateien)", h.Name)
		}
		name := strings.TrimPrefix(h.Name, "./")
		if !safeRel(name) {
			return nil, fmt.Errorf("update: unzulässiger Archivpfad %q", h.Name)
		}
		if h.Size < 0 || h.Size > MaxFileBytes {
			return nil, fmt.Errorf("update: Datei %q zu groß", name)
		}
		if _, dup := sums[name]; dup {
			return nil, fmt.Errorf("update: Archivpfad %q doppelt", name)
		}
		switch name {
		case ManifestName, SignatureName:
			if h.Size > MaxManifestBytes {
				return nil, fmt.Errorf("update: %s zu groß", name)
			}
			b, err := io.ReadAll(io.LimitReader(tr, MaxManifestBytes+1))
			if err != nil {
				return nil, fmt.Errorf("update: Archiv beschädigt: %w", err)
			}
			if name == ManifestName {
				manifestBytes = b
			} else {
				sigBytes = b
			}
			sums[name] = ""
		default:
			hs := sha256.New()
			n, err := io.Copy(hs, io.LimitReader(tr, MaxFileBytes+1))
			if err != nil {
				return nil, fmt.Errorf("update: Archiv beschädigt: %w", err)
			}
			if n != h.Size {
				return nil, fmt.Errorf("update: Datei %q: Größe passt nicht", name)
			}
			sums[name] = hex.EncodeToString(hs.Sum(nil))
		}
	}
	// Restbytes des gzip-Stroms lesen, damit `whole` den ganzen Datei-Hash sieht.
	if _, err := io.Copy(io.Discard, gz); err != nil {
		return nil, fmt.Errorf("update: Archiv beschädigt: %w", err)
	}
	if _, err := io.Copy(io.Discard, tee); err != nil {
		return nil, err
	}

	if manifestBytes == nil {
		return nil, ErrNoManifest
	}
	m, err := ParseManifest(manifestBytes)
	if err != nil {
		return nil, err
	}
	if opts.Arch != "" && m.Arch != opts.Arch {
		return nil, fmt.Errorf("update: Paket für %q, dieser Server ist %q", m.Arch, opts.Arch)
	}

	listed := map[string]bool{ManifestName: true, SignatureName: true}
	for _, c := range m.Components {
		got, ok := sums[c.Path]
		if !ok {
			return nil, fmt.Errorf("update: Komponente %q fehlt im Archiv (%s)", c.ID, c.Path)
		}
		if got != c.SHA256 {
			return nil, fmt.Errorf("update: Komponente %q: Prüfsumme stimmt nicht", c.ID)
		}
		listed[c.Path] = true
	}
	for name := range sums {
		if !listed[name] {
			return nil, fmt.Errorf("update: Datei %q steht nicht im Manifest", name)
		}
	}

	pkg := &Package{Manifest: m, SHA256: hex.EncodeToString(whole.Sum(nil)), Size: st.Size()}
	if sigBytes != nil {
		keyID, ok := VerifySignature(manifestBytes, sigBytes, opts.Trusted)
		if ok {
			pkg.Signed, pkg.KeyID = true, keyID
		} else if !opts.AllowUnsigned {
			return nil, ErrBadSignature
		}
	} else if !opts.AllowUnsigned {
		return nil, ErrUnsigned
	}
	return pkg, nil
}

// ExtractFile entpackt die Archivdatei archivePath nach dst (Modus mode),
// verifiziert dabei die erwartete Prüfsumme und schreibt erst nach
// erfolgreicher Prüfung atomar (dst.tmp → rename ist Aufgabe des
// Aufrufers; hier wird direkt nach dst geschrieben und bei Fehler
// gelöscht).
func ExtractFile(pkgPath, archivePath, wantSHA string, dst string, mode os.FileMode) error {
	f, err := os.Open(pkgPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("update: %q nicht im Archiv", archivePath)
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg || strings.TrimPrefix(h.Name, "./") != archivePath {
			continue
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			return err
		}
		hs := sha256.New()
		_, cpErr := io.Copy(io.MultiWriter(out, hs), io.LimitReader(tr, MaxFileBytes))
		if cpErr == nil {
			cpErr = out.Sync()
		}
		if cerr := out.Close(); cpErr == nil {
			cpErr = cerr
		}
		if cpErr == nil && hex.EncodeToString(hs.Sum(nil)) != wantSHA {
			cpErr = errors.New("update: Prüfsumme beim Entpacken stimmt nicht")
		}
		if cpErr == nil {
			cpErr = os.Chmod(dst, mode)
		}
		if cpErr != nil {
			_ = os.Remove(dst)
			return cpErr
		}
		return nil
	}
}

// ---- Signatur -------------------------------------------------------

// KeyID: erste 8 Byte des SHA-256 des Public Keys, hex.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// VerifySignature prüft die Base64-Signatur sig über manifest gegen alle
// Trusted-Schlüssel.
func VerifySignature(manifest, sig []byte, trusted []ed25519.PublicKey) (keyID string, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return "", false
	}
	for _, k := range trusted {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, manifest, raw) {
			return KeyID(k), true
		}
	}
	return "", false
}

// Sign erzeugt die Base64-Signatur für manifest.
func Sign(priv ed25519.PrivateKey, manifest []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, manifest)) + "\n")
}

// ParsePublicKeys liest eine Datei mit einem Base64-kodierten
// 32-Byte-Ed25519-Schlüssel pro Zeile (`#`-Kommentare und Leerzeilen
// erlaubt).
func ParsePublicKeys(data []byte) ([]ed25519.PublicKey, error) {
	var keys []ed25519.PublicKey
	for i, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(line)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("update: Schlüsseldatei Zeile %d ungültig", i+1)
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	return keys, nil
}

// LoadPublicKeys liest ParsePublicKeys aus einer Datei. Eine fehlende
// Datei ergibt eine leere Liste (kein Schlüssel = nichts vertrauenswürdig).
func LoadPublicKeys(file string) ([]ed25519.PublicKey, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParsePublicKeys(data)
}

// ---- Versionen ------------------------------------------------------

// CompareVersions vergleicht zwei Versionen numerisch je Punkt-Segment
// ("2026.10.0" > "2026.9.3"); Zusätze nach `-`/`+` werden ignoriert.
// Rückgabe -1/0/1.
func CompareVersions(a, b string) int {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(v string) []int {
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out []int
	for _, s := range strings.Split(v, ".") {
		n, _ := strconv.Atoi(s)
		out = append(out, n)
	}
	return out
}

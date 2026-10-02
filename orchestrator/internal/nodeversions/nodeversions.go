// Package nodeversions ist der Versionsspeicher für Node-Binaries (Kapitel 28).
//
// Pro Node-Typ (Binary-Name, z. B. "omp-audio-mixer") liegen beliebig viele
// Versionen nebeneinander; höchstens eine ist als PRODUKTIV markiert. Der
// Launcher startet neue Instanzen aus der produktiven Version; ohne Markierung
// gilt das im Katalog verzeichnete (installierte) Binary. Auf-/Abwärtswechsel
// ist damit „andere Version produktiv setzen“ — ohne Gesamt-Update.
//
// Die Version eines Binaries steht NICHT in dessen Dateinamen, sondern wird aus
// dem eingebetteten Marker gelesen (`OMPBUILD1{…}OMPBUILD1END`, geschrieben vom
// omp-node-sdk, ohne das Binary auszuführen). Dev-Builds tragen "dev" und
// werden nie automatisch archiviert (jeder Neubau wäre eine „neue Version“).
//
// Layout: <dir>/<name>/<id>/<name> + meta.json, <dir>/<name>/productive.
package nodeversions

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

var (
	// ErrNotFound: Typ oder Version unbekannt.
	ErrNotFound = errors.New("nodeversions: nicht gefunden")
	// ErrConflict: gleiche Versionsnummer, anderer Inhalt.
	ErrConflict = errors.New("nodeversions: Version existiert bereits mit anderem Inhalt")
	// ErrNoMarker: Datei trägt keinen Build-Stempel (kein OMP-Node).
	ErrNoMarker = errors.New("nodeversions: kein Build-Stempel im Binary gefunden")

	namePattern = regexp.MustCompile(`^omp-[a-z0-9][a-z0-9-]{0,62}$`)
	idPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
)

// Info ist der aus einem Binary gelesene Stempel.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
}

const (
	markerStart = "OMPBUILD1{"
	markerEnd   = "}OMPBUILD1END"
)

// ReadMarker sucht den Build-Stempel in einer Datei (streamend, Chunk-Überlappung).
func ReadMarker(path string) (Info, error) {
	f, err := os.Open(path)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	const chunk = 4 << 20
	const overlap = 512
	buf := make([]byte, chunk+overlap)
	have := 0
	for {
		n, rerr := f.Read(buf[have : have+chunk])
		have += n
		window := buf[:have]
		if i := bytes.Index(window, []byte(markerStart)); i >= 0 {
			rest := window[i+len(markerStart)-1:] // ab "{"
			if j := bytes.Index(rest, []byte(markerEnd)); j >= 0 {
				var info Info
				if err := json.Unmarshal(rest[:j+1], &info); err != nil {
					return Info{}, fmt.Errorf("nodeversions: Stempel unlesbar: %w", err)
				}
				return info, nil
			}
			// Marker beginnt, Ende fehlt noch: ab Markeranfang weiterlesen.
			copy(buf, window[i:])
			have -= i
			if rerr != nil {
				return Info{}, ErrNoMarker
			}
			continue
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				return Info{}, ErrNoMarker
			}
			return Info{}, rerr
		}
		keep := overlap
		if have < keep {
			keep = have
		}
		copy(buf, window[have-keep:])
		have = keep
	}
}

// Version ist eine gespeicherte Binary-Version.
type Version struct {
	Name    string    `json:"name"`
	ID      string    `json:"id"`
	Version string    `json:"version"`
	Commit  string    `json:"commit,omitempty"`
	BuiltAt string    `json:"builtAt,omitempty"`
	SHA256  string    `json:"sha256"`
	Size    int64     `json:"size"`
	AddedAt time.Time `json:"addedAt"`
	// Source: woher die Version kam („Update 2026.10.1“, „installiert“, „Import“).
	Source string `json:"source,omitempty"`
}

// Store ist der Versionsspeicher.
type Store struct {
	dir string
	mu  sync.Mutex
}

// New legt einen Speicher unter dir an (das Verzeichnis entsteht beim ersten Add).
func New(dir string) *Store { return &Store{dir: dir} }

// VersionID bildet die Speicher-ID: die Versionsnummer, bei "dev" mit
// Inhaltsprüfsumme (jeder Dev-Build ist ein eigener Stand).
func VersionID(version, sha string) string {
	if version == "" || version == "dev" {
		if len(sha) > 12 {
			sha = sha[:12]
		}
		return "dev-" + sha
	}
	return version
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

// Add legt das Binary unter seiner Stempel-Version ab (Kopie, nicht Hardlink:
// ein späteres Update darf das archivierte Binary nie verändern). Existiert die
// Version mit gleichem Inhalt schon, ist das ein No-Op (liefert den Bestand).
func (s *Store) Add(name, srcPath, source string) (Version, error) {
	if !namePattern.MatchString(name) {
		return Version{}, fmt.Errorf("nodeversions: ungültiger Node-Name %q", name)
	}
	info, err := ReadMarker(srcPath)
	if err != nil {
		return Version{}, err
	}
	sha, size, err := hashFile(srcPath)
	if err != nil {
		return Version{}, err
	}
	id := VersionID(info.Version, sha)
	if !idPattern.MatchString(id) {
		return Version{}, fmt.Errorf("nodeversions: ungültige Version %q", info.Version)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, name, id)
	if existing, err := s.readMeta(dir); err == nil {
		if existing.SHA256 != sha {
			return Version{}, fmt.Errorf("%w (%s %s)", ErrConflict, name, id)
		}
		return existing, nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return Version{}, err
	}
	dst := filepath.Join(dir, name)
	if err := copyFile(srcPath, dst+".part", 0o755); err != nil {
		return Version{}, err
	}
	if err := os.Rename(dst+".part", dst); err != nil {
		return Version{}, err
	}
	v := Version{Name: name, ID: id, Version: info.Version, Commit: info.Commit, BuiltAt: info.BuiltAt,
		SHA256: sha, Size: size, AddedAt: time.Now().UTC(), Source: source}
	meta, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o640); err != nil {
		_ = os.RemoveAll(dir)
		return Version{}, err
	}
	return v, nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}

func (s *Store) readMeta(dir string) (Version, error) {
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return Version{}, err
	}
	var v Version
	return v, json.Unmarshal(data, &v)
}

// Names liefert die Typen mit mindestens einer gespeicherten Version.
func (s *Store) Names() []string {
	entries, _ := os.ReadDir(s.dir)
	var out []string
	for _, e := range entries {
		if e.IsDir() && namePattern.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// List liefert die Versionen eines Typs, neueste zuerst.
func (s *Store) List(name string) []Version {
	if !namePattern.MatchString(name) {
		return nil
	}
	entries, _ := os.ReadDir(filepath.Join(s.dir, name))
	var out []Version
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if v, err := s.readMeta(filepath.Join(s.dir, name, e.Name())); err == nil {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AddedAt.After(out[j].AddedAt) })
	return out
}

// Path liefert den Binary-Pfad einer Version.
func (s *Store) Path(name, id string) (string, error) {
	if !namePattern.MatchString(name) || !idPattern.MatchString(id) {
		return "", ErrNotFound
	}
	p := filepath.Join(s.dir, name, id, name)
	if _, err := os.Stat(p); err != nil {
		return "", ErrNotFound
	}
	return p, nil
}

// Productive liefert die produktive Version ("" = keine, das installierte Binary gilt).
func (s *Store) Productive(name string) string {
	if !namePattern.MatchString(name) {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(s.dir, name, "productive"))
	if err != nil {
		return ""
	}
	id := strings.TrimSpace(string(data))
	if _, err := s.Path(name, id); err != nil {
		return "" // Version gelöscht/defekt: auf das installierte Binary zurückfallen
	}
	return id
}

// SetProductive markiert eine Version als produktiv; id == "" hebt die
// Markierung auf (zurück zum installierten Binary).
func (s *Store) SetProductive(name, id string) error {
	if !namePattern.MatchString(name) {
		return ErrNotFound
	}
	file := filepath.Join(s.dir, name, "productive")
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if _, err := s.Path(name, id); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(id+"\n"), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// Delete entfernt eine Version; die produktive lässt sich nicht löschen.
func (s *Store) Delete(name, id string) error {
	if _, err := s.Path(name, id); err != nil {
		return err
	}
	if s.Productive(name) == id {
		return errors.New("nodeversions: die produktive Version lässt sich nicht löschen")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.RemoveAll(filepath.Join(s.dir, name, id))
}

// Resolve ist der Hook des Launchers: Pfad und Versions-ID der produktiven
// Version, oder ("", "") wenn das installierte Binary gelten soll.
func (s *Store) Resolve(name string) (path, id string) {
	id = s.Productive(name)
	if id == "" {
		return "", ""
	}
	p, err := s.Path(name, id)
	if err != nil {
		return "", ""
	}
	return p, id
}

// installedCache merkt sich pro Pfad (Größe+Änderungszeit), was ReadMarker fand —
// Debug-Binaries sind hunderte MB groß, nicht bei jedem Listing neu lesen.
type installedKey struct {
	path string
	size int64
	mod  int64
}

type installedVal struct {
	info Info
	err  error
}

var (
	installedMu    sync.Mutex
	installedCache = map[installedKey]installedVal{}
)

// InstalledInfo liest (gecacht) den Stempel eines installierten Binaries.
func InstalledInfo(path string) (Info, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Info{}, err
	}
	k := installedKey{path, st.Size(), st.ModTime().UnixNano()}
	installedMu.Lock()
	v, ok := installedCache[k]
	installedMu.Unlock()
	if ok {
		return v.info, v.err
	}
	info, err := ReadMarker(path)
	installedMu.Lock()
	installedCache[k] = installedVal{info, err}
	installedMu.Unlock()
	return info, err
}

// RegisterInstalled archiviert die gerade installierten Binaries (name → Pfad),
// damit man nach einem Update zu ihnen zurückkehren kann. Dev-Builds und
// Binaries ohne Stempel werden übersprungen (siehe Paketdoku).
func (s *Store) RegisterInstalled(paths map[string]string) (added []Version, skipped map[string]string) {
	skipped = map[string]string{}
	for name, p := range paths {
		info, err := InstalledInfo(p)
		switch {
		case err != nil:
			skipped[name] = err.Error()
			continue
		case info.Version == "" || info.Version == "dev":
			skipped[name] = "Dev-Build (nicht versioniert)"
			continue
		}
		if _, err := s.Path(name, info.Version); err == nil {
			continue // schon archiviert
		}
		v, err := s.Add(name, p, "installiert")
		if err != nil {
			skipped[name] = err.Error()
			continue
		}
		added = append(added, v)
	}
	return added, skipped
}

// RegisterPackage legt alle Node-Binaries (Ziel "node:<name>") eines geprüften
// Update-Pakets im Speicher ab — schon beim Hochladen, nicht erst beim Anwenden:
// so lässt sich ein einzelner Typ umstellen, ohne das ganze System zu updaten.
func (s *Store) RegisterPackage(pkgFile string, m update.Manifest, source string) ([]Version, error) {
	tmpDir, err := os.MkdirTemp(s.dir, ".incoming-")
	if err != nil {
		if mkErr := os.MkdirAll(s.dir, 0o750); mkErr != nil {
			return nil, mkErr
		}
		if tmpDir, err = os.MkdirTemp(s.dir, ".incoming-"); err != nil {
			return nil, err
		}
	}
	defer os.RemoveAll(tmpDir)
	var out []Version
	for _, c := range m.Components {
		name, ok := strings.CutPrefix(c.Target, "node:")
		if !ok {
			continue
		}
		tmp := filepath.Join(tmpDir, name)
		if err := update.ExtractFile(pkgFile, c.Path, c.SHA256, tmp, 0o755); err != nil {
			return out, fmt.Errorf("%s: %w", name, err)
		}
		v, err := s.Add(name, tmp, source)
		if err != nil {
			if errors.Is(err, ErrNoMarker) {
				continue // Binary ohne Stempel (älteres Bundle): nicht versionierbar
			}
			return out, fmt.Errorf("%s: %w", name, err)
		}
		out = append(out, v)
	}
	return out, nil
}

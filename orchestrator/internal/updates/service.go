// Package updates verwaltet hochgeladene System-Update-Pakete
// (docs/ENTWURF-SYSTEM-UPDATE.md): Streaming-Import mit vollständiger
// Prüfung (Struktur, SHA-256, Ed25519-Signatur), Ablage unter
// OMP_UPDATE_DIR, Liste/Löschen und Lesen der vom Supervisor
// geschriebenen Update-Historie. Angewendet wird ein Paket NICHT hier,
// sondern vom eigenständigen Supervisor (der den Orchestrator dafür
// stoppen muss) — dieses Paket liefert ihm nur die geprüfte Datei.
package updates

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

// ErrNotFound: kein Paket mit dieser ID.
var ErrNotFound = errors.New("update-paket nicht gefunden")

// ErrTooLarge: Upload größer als das Limit.
var ErrTooLarge = errors.New("update-paket zu groß")

var idPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]*-[0-9a-f]{12}$`)

// Entry beschreibt ein abgelegtes, geprüftes Paket.
type Entry struct {
	ID         string          `json:"id"`
	File       string          `json:"-"`
	Version    string          `json:"version"`
	Signed     bool            `json:"signed"`
	KeyID      string          `json:"keyId,omitempty"`
	SHA256     string          `json:"sha256"`
	Size       int64           `json:"size"`
	UploadedAt time.Time       `json:"uploadedAt"`
	Manifest   update.Manifest `json:"manifest"`
}

// HistoryEntry ist ein Eintrag der vom Supervisor geführten Historie
// (`<dir>/history.json`).
type HistoryEntry struct {
	Time       time.Time `json:"time"`
	From       string    `json:"from,omitempty"`
	Version    string    `json:"version"`
	Ok         bool      `json:"ok"`
	RolledBack bool      `json:"rolledBack,omitempty"`
	Error      string    `json:"error,omitempty"`
}

// Service verwaltet das Update-Verzeichnis.
type Service struct {
	dir           string
	keyFile       string
	allowUnsigned bool
	arch          string
	maxBytes      int64
}

// New: dir = OMP_UPDATE_DIR, keyFile = Datei mit vertrauenswürdigen
// Public Keys. maxBytes <= 0 → 2 GiB.
func New(dir, keyFile string, allowUnsigned bool, arch string, maxBytes int64) *Service {
	if maxBytes <= 0 {
		maxBytes = 2 << 30
	}
	return &Service{dir: dir, keyFile: keyFile, allowUnsigned: allowUnsigned, arch: arch, maxBytes: maxBytes}
}

// Dir ist das Update-Verzeichnis.
func (s *Service) Dir() string { return s.dir }

// AllowUnsigned meldet, ob unsignierte Pakete akzeptiert werden.
func (s *Service) AllowUnsigned() bool { return s.allowUnsigned }

// TrustedKeyIDs listet die Kennungen der vertrauenswürdigen Schlüssel.
func (s *Service) TrustedKeyIDs() []string {
	keys, _ := update.LoadPublicKeys(s.keyFile)
	ids := make([]string, 0, len(keys))
	for _, k := range keys {
		ids = append(ids, update.KeyID(k))
	}
	return ids
}

func (s *Service) options() (update.Options, error) {
	keys, err := update.LoadPublicKeys(s.keyFile)
	if err != nil {
		return update.Options{}, fmt.Errorf("vertrauenswürdige Schlüssel lesen: %w", err)
	}
	return update.Options{Trusted: keys, AllowUnsigned: s.allowUnsigned, Arch: s.arch}, nil
}

// Import streamt r in das Update-Verzeichnis, prüft das Paket und legt es
// unter `<version>-<sha12>.tar.gz` ab. Bei jedem Fehler bleibt nichts
// zurück.
func (s *Service) Import(r io.Reader) (Entry, error) {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return Entry{}, err
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	tmp := filepath.Join(s.dir, "incoming-"+hex.EncodeToString(rnd[:])+".part")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return Entry{}, err
	}
	defer os.Remove(tmp)

	n, err := io.Copy(f, io.LimitReader(r, s.maxBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Entry{}, err
	}
	if n > s.maxBytes {
		return Entry{}, ErrTooLarge
	}

	opts, err := s.options()
	if err != nil {
		return Entry{}, err
	}
	pkg, err := update.ReadPackage(tmp, opts)
	if err != nil {
		return Entry{}, err
	}
	id := fmt.Sprintf("%s-%s", pkg.Manifest.Version, pkg.SHA256[:12])
	if !idPattern.MatchString(id) {
		return Entry{}, fmt.Errorf("ungültige Paket-ID %q", id)
	}
	final := filepath.Join(s.dir, id+".tar.gz")
	if err := os.Rename(tmp, final); err != nil {
		return Entry{}, err
	}
	e := Entry{
		ID: id, File: final, Version: pkg.Manifest.Version, Signed: pkg.Signed, KeyID: pkg.KeyID,
		SHA256: pkg.SHA256, Size: pkg.Size, UploadedAt: time.Now().UTC(), Manifest: pkg.Manifest,
	}
	meta, _ := json.MarshalIndent(e, "", "  ")
	if err := os.WriteFile(filepath.Join(s.dir, id+".json"), meta, 0o640); err != nil {
		_ = os.Remove(final)
		return Entry{}, err
	}
	return e, nil
}

func (s *Service) load(id string) (Entry, error) {
	if !idPattern.MatchString(id) {
		return Entry{}, ErrNotFound
	}
	data, err := os.ReadFile(filepath.Join(s.dir, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, err
	}
	var e Entry
	if err := json.Unmarshal(data, &e); err != nil {
		return Entry{}, err
	}
	e.File = filepath.Join(s.dir, id+".tar.gz")
	if _, err := os.Stat(e.File); err != nil {
		return Entry{}, ErrNotFound
	}
	return e, nil
}

// Get liest den Metadaten-Eintrag (ohne erneute Prüfung).
func (s *Service) Get(id string) (Entry, error) { return s.load(id) }

// Verify prüft das abgelegte Paket ERNEUT vollständig (Archiv könnte seit
// dem Upload verändert worden sein, Schlüsselliste könnte sich geändert
// haben) — vor jedem Anwenden.
func (s *Service) Verify(id string) (Entry, error) {
	e, err := s.load(id)
	if err != nil {
		return Entry{}, err
	}
	opts, err := s.options()
	if err != nil {
		return Entry{}, err
	}
	pkg, err := update.ReadPackage(e.File, opts)
	if err != nil {
		return Entry{}, err
	}
	if pkg.SHA256 != e.SHA256 {
		return Entry{}, errors.New("paket wurde seit dem Upload verändert")
	}
	e.Signed, e.KeyID, e.Manifest = pkg.Signed, pkg.KeyID, pkg.Manifest
	return e, nil
}

// List liefert alle abgelegten Pakete, neueste zuerst.
func (s *Service) List() ([]Entry, error) {
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	for _, f := range files {
		base := filepath.Base(f)
		id := base[:len(base)-len(".json")]
		if !idPattern.MatchString(id) {
			continue // history.json u. ä.
		}
		if e, err := s.load(id); err == nil {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UploadedAt.After(out[j].UploadedAt) })
	return out, nil
}

// Delete entfernt Paket und Metadaten.
func (s *Service) Delete(id string) error {
	if _, err := s.load(id); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(s.dir, id+".json"))
	return os.Remove(filepath.Join(s.dir, id+".tar.gz"))
}

// History liest die vom Supervisor geführte Historie (neueste zuerst).
func (s *Service) History() ([]HistoryEntry, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, "history.json"))
	if errors.Is(err, os.ErrNotExist) {
		return []HistoryEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	var h []HistoryEntry
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, err
	}
	sort.Slice(h, func(i, j int) bool { return h[i].Time.After(h[j].Time) })
	return h, nil
}

// Package microsvc verwaltet die auf diesem Host installierten, importierten Microservices (Kap. 85).
//
// Sicherheitsmodell (Entscheidungen E1/E3 in UMSETZUNG.md Kap. 85):
//   - Vertrauensanker ist der Verteilschlüssel des Clusters (Ed25519, öffentlicher Teil in dist.pub neben den
//     Installationen). Er wird einmalig per signiertem Kommando hinterlegt (catalog-trust) oder per Datei vorgegeben.
//     Ein anderer Schlüssel ersetzt ihn nicht stillschweigend.
//   - Der Host entscheidet über Vertrauens-Erweiterungen des Eintrags (mxlAccess, mediaRead, hostNetwork, extraPort,
//     dataDir) per lokaler Allowlist. Verlangt ein Eintrag mehr, wird die Installation abgelehnt — nie stillschweigend
//     abgeschwächt.
//   - Installiert wird nur, was Signatur UND Prüfsumme des Image-Archivs besteht; erst dann `podman load`.
package microsvc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/podmanrun"
	"github.com/infantilo/openmediaplatform/update"
)

// Optin-Namen (identisch zu den JSON-Feldern des Katalogeintrags).
const (
	OptMxlAccess   = "mxlAccess"
	OptMediaRead   = "mediaRead"
	OptHostNetwork = "hostNetwork"
	OptExtraPort   = "extraPort"
	OptDataDir     = "dataDir"
)

// DefaultAllow: ohne Konfiguration erlaubt ein Host alle Erweiterungen (Nutzerentscheidung 2026-11-04). Der Import ist
// admin-only, das Bundle signiert und der Contract-Check bestanden; wer einen Host enger fassen will, setzt
// OMP_MICROSERVICE_ALLOW (z. B. "extraPort,dataDir" oder "none" für gar keine Erweiterung).
var DefaultAllow = []string{OptMxlAccess, OptMediaRead, OptHostNetwork, OptExtraPort, OptDataDir}

// ParseAllow liest eine Kommaliste (OMP_MICROSERVICE_ALLOW); leer = DefaultAllow.
func ParseAllow(s string) map[string]bool {
	out := map[string]bool{}
	list := DefaultAllow
	if strings.TrimSpace(s) != "" {
		list = strings.Split(s, ",")
	}
	if strings.EqualFold(strings.TrimSpace(s), "none") {
		return out
	}
	for _, v := range list {
		if v = strings.TrimSpace(v); v != "" {
			out[v] = true
		}
	}
	return out
}

// Installed ist ein installierter Microservice.
type Installed struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	Label   string `json:"label,omitempty"`
	Image   string `json:"image"`
	ImageID string `json:"imageId"`
	// Entry: der für diesen Host ausgewertete Katalogeintrag.
	Entry catalog.Entry `json:"entry"`
}

// Store ist das Verzeichnis der Installationen.
type Store struct {
	dir   string
	allow map[string]bool
	// MinFreeBytes: Platzreserve zusätzlich zur Imagegröße (Standard 1 GiB).
	MinFreeBytes int64

	mu sync.Mutex
}

// NewStore legt das Verzeichnis an. allow = erlaubte Opt-ins (ParseAllow).
func NewStore(dir string, allow map[string]bool) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "installed"), 0o750); err != nil {
		return nil, err
	}
	return &Store{dir: dir, allow: allow, MinFreeBytes: 1 << 30}, nil
}

// Dir ist das Arbeitsverzeichnis.
func (s *Store) Dir() string { return s.dir }

func (s *Store) keyFile() string { return filepath.Join(s.dir, "dist.pub") }

// TrustKey hinterlegt den Verteilschlüssel (Base64-Zeile). Gleicher Schlüssel = ok; kein Schlüssel = speichern;
// anderer Schlüssel = Fehler (zum Wechsel die Datei dist.pub bewusst löschen).
func (s *Store) TrustKey(pubLine string) error {
	keys, err := update.ParsePublicKeys([]byte(pubLine))
	if err != nil || len(keys) != 1 {
		return errors.New("verteilschlüssel ungültig")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := update.LoadPublicKeys(s.keyFile())
	if err != nil {
		return err
	}
	if len(cur) > 0 {
		for _, k := range cur {
			if k.Equal(keys[0]) {
				return nil
			}
		}
		return errors.New("auf diesem Host ist bereits ein anderer Verteilschlüssel hinterlegt (dist.pub bewusst löschen, um ihn zu wechseln)")
	}
	tmp := s.keyFile() + ".new"
	if err := os.WriteFile(tmp, []byte(update.EncodePublicKey(keys[0])+"\n"), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, s.keyFile())
}

// HasKey meldet, ob ein Verteilschlüssel hinterlegt ist.
func (s *Store) HasKey() bool {
	k, _ := update.LoadPublicKeys(s.keyFile())
	return len(k) > 0
}

// DownloadPath ist der Zielpfad für ein heruntergeladenes Bundle.
func (s *Store) DownloadPath(name string) string {
	return filepath.Join(s.dir, "download-"+name+".tar")
}

// freeBytes: freier Platz am Pfad.
var freeBytes = func(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// loadImage lädt das Image (Variable: Tests ersetzen es).
var loadImage = func(imagePath string) error {
	out, err := exec.Command(podmanrun.Binary, "load", "-i", imagePath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("podman load: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

var imageID = podmanrun.ImageDigest

// Install prüft und installiert ein heruntergeladenes Bundle. Rückgabe: Beschreibung.
func (s *Store) Install(bundlePath string) (Installed, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var zero Installed
	keys, err := update.LoadPublicKeys(s.keyFile())
	if err != nil {
		return zero, err
	}
	if len(keys) == 0 {
		return zero, errors.New("kein Verteilschlüssel hinterlegt — Bundle wird nicht angenommen")
	}
	if st, err := os.Stat(bundlePath); err == nil {
		need := st.Size()*2 + s.MinFreeBytes // Bundle + extrahiertes Image + Reserve
		if free, ferr := freeBytes(s.dir); ferr == nil && free < need {
			return zero, fmt.Errorf("zu wenig freier Platz (%d MiB frei, ~%d MiB nötig)", free>>20, need>>20)
		}
	}
	imgPath := bundlePath + ".image"
	defer os.Remove(imgPath)
	m, _, err := update.OpenBundle(bundlePath, keys, imgPath)
	if err != nil {
		return zero, err
	}
	var entry catalog.Entry
	if err := json.Unmarshal(m.Entry, &entry); err != nil {
		return zero, fmt.Errorf("katalogeintrag: %w", err)
	}
	if entry.Type != m.Type {
		return zero, errors.New("katalogeintrag passt nicht zum Manifest (Typ)")
	}
	if entry.Runner != catalog.RunnerPodman || entry.Image == "" || entry.Image != m.Image {
		return zero, errors.New("katalogeintrag muss ein Container-Eintrag mit dem Image des Manifests sein")
	}
	entry.Version = m.Version
	if err := s.checkOptIns(entry); err != nil {
		return zero, err
	}
	if err := loadImage(imgPath); err != nil {
		return zero, err
	}
	got, err := imageID(m.Image)
	if err != nil {
		return zero, err
	}
	if m.ImageID != "" && got != m.ImageID {
		_ = podmanrun.RemoveImage(m.Image)
		return zero, fmt.Errorf("geladenes Image (%s) passt nicht zur signierten Image-ID (%s)", got, m.ImageID)
	}
	inst := Installed{Type: m.Type, Version: m.Version, Label: m.Label, Image: m.Image, ImageID: got, Entry: entry}
	data, _ := json.MarshalIndent(inst, "", "  ")
	file := s.fileFor(m.Type, m.Version)
	tmp := file + ".new"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return zero, err
	}
	if err := os.Rename(tmp, file); err != nil {
		return zero, err
	}
	return inst, nil
}

// checkOptIns wendet die lokale Allowlist an.
func (s *Store) checkOptIns(e catalog.Entry) error {
	var denied []string
	for name, want := range map[string]bool{
		OptMxlAccess: e.MxlAccess, OptMediaRead: e.MediaRead, OptHostNetwork: e.HostNetwork,
		OptExtraPort: e.ExtraPort, OptDataDir: e.DataDir != "",
	} {
		if want && !s.allow[name] {
			denied = append(denied, name)
		}
	}
	if len(denied) > 0 {
		sort.Strings(denied)
		return fmt.Errorf("dieser Host erlaubt %s nicht (OMP_MICROSERVICE_ALLOW)", strings.Join(denied, ", "))
	}
	return nil
}

func (s *Store) fileFor(t, v string) string {
	return filepath.Join(s.dir, "installed", t+"@"+v+".json")
}

// List liefert alle Installationen (sortiert).
func (s *Store) List() []Installed {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, _ := filepath.Glob(filepath.Join(s.dir, "installed", "*.json"))
	var out []Installed
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var in Installed
		if json.Unmarshal(b, &in) == nil && in.Type != "" {
			out = append(out, in)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return update.CompareVersions(out[i].Version, out[j].Version) < 0
	})
	return out
}

// Find liefert die Installation für Typ und Version (leer = neueste).
func (s *Store) Find(nodeType, version string) (catalog.Entry, bool) {
	var best *Installed
	all := s.List()
	for i := range all {
		if all[i].Type != nodeType || (version != "" && all[i].Version != version) {
			continue
		}
		best = &all[i]
	}
	if best == nil {
		return catalog.Entry{}, false
	}
	return best.Entry, true
}

// Remove entfernt eine Installation samt Image (und beim letzten Versionsstand das Datenvolumen).
// inUse meldet, ob noch eine Instanz dieses Typs/dieser Version läuft.
func (s *Store) Remove(nodeType, version string, inUse func(t, v string) bool) error {
	if !update.ValidBundleName(nodeType) || !update.ValidBundleName(version) {
		return errors.New("ungültiger Name")
	}
	if inUse != nil && inUse(nodeType, version) {
		return errors.New("es läuft noch eine Instanz dieser Version auf diesem Host")
	}
	s.mu.Lock()
	file := s.fileFor(nodeType, version)
	b, err := os.ReadFile(file)
	if err != nil {
		s.mu.Unlock()
		if os.IsNotExist(err) {
			return nil // schon weg
		}
		return err
	}
	var in Installed
	_ = json.Unmarshal(b, &in)
	if err := os.Remove(file); err != nil {
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()
	stillUsed := false
	typeLeft := false
	for _, o := range s.List() {
		if o.Image == in.Image {
			stillUsed = true
		}
		if o.Type == nodeType {
			typeLeft = true
		}
	}
	var errs []string
	if in.Image != "" && !stillUsed {
		if err := podmanrun.RemoveImage(in.Image); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if !typeLeft && in.Entry.DataDir != "" {
		if err := podmanrun.RemoveDataVolume(nodeType); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

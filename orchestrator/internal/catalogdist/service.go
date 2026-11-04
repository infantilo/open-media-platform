package catalogdist

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

// Repo ist der Zustandsspeicher (implementiert von *Store; Tests nutzen eine Speicher-Variante).
type Repo interface {
	Key() (ed25519.PrivateKey, string, error)
	Upsert(typ, version, hostID, desired string) error
	Set(typ, version, hostID, state, detail, imageID string, failed bool) error
	Delete(typ, version, hostID string) error
	List() ([]Row, error)
}

// HostRef identifiziert einen Host.
type HostRef struct{ ID, Label string }

// Tokens stellt Einmal-Token für den Bundle-Download aus (implementiert von *updates.Downloads).
type Tokens interface {
	Issue(id string) string
	Check(id, token string) bool
}

// EntrySource liefert den Katalogeintrag eines importierten Container-Typs.
type EntrySource func(typ, version string) (entry json.RawMessage, image, label string, ok bool)

// Timeouts.
const (
	installTimeout = 25 * time.Minute
	trustTimeout   = 15 * time.Second
	listTimeout    = 15 * time.Second
	tick           = 15 * time.Second
	verifyEvery    = 2 * time.Minute
)

// Service verteilt Bundles. Alle Fremdzugriffe sind Funktionsfelder (in main.go verdrahtet, in Tests ersetzt).
type Service struct {
	Repo   Repo
	Tokens Tokens
	// Dir: Zwischenspeicher der gebauten Bundles.
	Dir     string
	Hosts   func() ([]HostRef, error)
	Online  func(hostID string) bool
	Request func(subject string, data []byte, timeout time.Duration) ([]byte, error)
	Entry   EntrySource
	// SaveImage schreibt das Image als Archiv (podman save). Standard: podman.
	SaveImage func(image, dst string) error
	// ImageID liefert die ID des lokalen Images. Standard: podman.
	ImageID func(image string) (string, error)
	// Parallel: gleichzeitige Host-Aktionen (Standard 2, schont Orchestrator-Bandbreite und Platten).
	Parallel int

	kick chan struct{}

	mu       sync.Mutex
	bundles  map[string]*bundle // Schlüssel typ@version
	building map[string]*sync.Mutex
	lastList map[string]time.Time
}

type bundle struct {
	id, path, sha, imageID string
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]*$`)

func (s *Service) init() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.kick == nil {
		s.kick = make(chan struct{}, 1)
		s.bundles = map[string]*bundle{}
		s.building = map[string]*sync.Mutex{}
		s.lastList = map[string]time.Time{}
	}
	if s.Parallel <= 0 {
		s.Parallel = 2
	}
	if s.SaveImage == nil {
		s.SaveImage = func(image, dst string) error {
			out, err := exec.Command("podman", "save", "-o", dst, image).CombinedOutput()
			if err != nil {
				return fmt.Errorf("podman save %s: %w (%s)", image, err, strings.TrimSpace(string(out)))
			}
			return nil
		}
	}
	if s.ImageID == nil {
		s.ImageID = func(image string) (string, error) {
			out, err := exec.Command("podman", "image", "inspect", "--format", "{{.Id}}", image).Output()
			if err != nil {
				return "", fmt.Errorf("podman image inspect %s: %w", image, err)
			}
			id := strings.TrimSpace(string(out))
			if !strings.HasPrefix(id, "sha256:") {
				id = "sha256:" + id
			}
			return id, nil
		}
	}
}

// Kick löst einen sofortigen Abgleich aus.
func (s *Service) Kick() {
	s.init()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// ErrUnknownType: Typ/Version ist kein importierter Container-Typ dieses Orchestrators.
var ErrUnknownType = errors.New("typ/version ist kein importierter Container-Microservice")

// Distribute setzt den Soll-Zustand „installiert“ für die Hosts.
func (s *Service) Distribute(typ, version string, hostIDs []string) error {
	s.init()
	if !update.ValidBundleName(typ) || !update.ValidBundleName(version) || strings.Contains(typ+version, "..") {
		return errors.New("typ/version enthalten unzulässige Zeichen (erlaubt: Buchstaben, Ziffern, . _ -)")
	}
	if _, _, _, ok := s.Entry(typ, version); !ok {
		return ErrUnknownType
	}
	if len(hostIDs) == 0 {
		return errors.New("kein Host angegeben")
	}
	for _, h := range hostIDs {
		if err := s.Repo.Upsert(typ, version, h, DesiredPresent); err != nil {
			return err
		}
	}
	s.Kick()
	return nil
}

// Withdraw setzt den Soll-Zustand „entfernt“ für die Hosts (leer = alle Hosts mit einer Zeile).
func (s *Service) Withdraw(typ, version string, hostIDs []string) error {
	s.init()
	if len(hostIDs) == 0 {
		rows, err := s.Repo.List()
		if err != nil {
			return err
		}
		for _, r := range rows {
			if r.Type == typ && r.Version == version {
				hostIDs = append(hostIDs, r.HostID)
			}
		}
	}
	for _, h := range hostIDs {
		if err := s.Repo.Upsert(typ, version, h, DesiredAbsent); err != nil {
			return err
		}
	}
	s.dropBundle(typ, version)
	s.Kick()
	return nil
}

// Retry setzt eine fehlgeschlagene Zeile zurück.
func (s *Service) Retry(typ, version, hostID string) error {
	rows, err := s.Repo.List()
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.Type == typ && r.Version == version && r.HostID == hostID {
			if err := s.Repo.Upsert(typ, version, hostID, r.Desired); err != nil {
				return err
			}
			s.Kick()
			return nil
		}
	}
	return errors.New("keine Verteilung für diesen Host")
}

// Rows liefert alle Zeilen.
func (s *Service) Rows() ([]Row, error) { return s.Repo.List() }

// InstalledOn meldet, ob (Typ, Version) auf dem Host installiert ist.
func (s *Service) InstalledOn(typ, version, hostID string) bool {
	rows, err := s.Repo.List()
	if err != nil {
		return false
	}
	for _, r := range rows {
		if r.Type == typ && r.HostID == hostID && r.Desired == DesiredPresent && r.State == StateOK && (version == "" || r.Version == version) {
			return true
		}
	}
	return false
}

// HostsWith liefert die Host-IDs, auf denen der Typ installiert ist (version leer = irgendeine).
func (s *Service) HostsWith(typ string) map[string]bool {
	out := map[string]bool{}
	rows, err := s.Repo.List()
	if err != nil {
		return out
	}
	for _, r := range rows {
		if r.Type == typ && r.Desired == DesiredPresent && r.State == StateOK {
			out[r.HostID] = true
		}
	}
	return out
}

// ErrNotInstalled: der importierte Microservice ist auf dem Ziel-Host nicht installiert (HTTP 409).
var ErrNotInstalled = errors.New("microservice auf diesem Host nicht installiert")

// CheckStart ist der Remote-Start-Wächter des Launchers: ohne Installation auf dem Host eine klare Meldung statt OMP-2002.
func (s *Service) CheckStart(typ, version, hostID string) error {
	if s.InstalledOn(typ, version, hostID) {
		return nil
	}
	return &notInstalledError{fmt.Sprintf("der Microservice %q (Version %s) ist auf diesem Host nicht installiert — im Node-Katalog unter „Hosts“ verteilen", typ, version)}
}

// notInstalledError trägt die lesbare Meldung und erfüllt errors.Is(err, ErrNotInstalled).
type notInstalledError struct{ msg string }

func (e *notInstalledError) Error() string        { return e.msg }
func (e *notInstalledError) Is(target error) bool { return target == ErrNotInstalled }

// BundleFile liefert den Pfad eines gebauten Bundles für den Download.
func (s *Service) BundleFile(id string) (string, bool) {
	if !idPattern.MatchString(id) || strings.Contains(id, "..") {
		return "", false
	}
	p := filepath.Join(s.Dir, id+".tar")
	if _, err := os.Stat(p); err != nil {
		return "", false
	}
	return p, true
}

// CheckToken prüft ein Download-Token.
func (s *Service) CheckToken(id, token string) bool {
	return s.Tokens != nil && s.Tokens.Check(id, token)
}

func (s *Service) dropBundle(typ, version string) {
	s.mu.Lock()
	b := s.bundles[typ+"@"+version]
	delete(s.bundles, typ+"@"+version)
	s.mu.Unlock()
	if b != nil {
		_ = os.Remove(b.path)
	}
}

// ensureBundle baut das Bundle (einmal je Typ/Version) und liefert es.
func (s *Service) ensureBundle(typ, version string) (*bundle, error) {
	key := typ + "@" + version
	s.mu.Lock()
	if b := s.bundles[key]; b != nil {
		if _, err := os.Stat(b.path); err == nil {
			s.mu.Unlock()
			return b, nil
		}
	}
	lock := s.building[key]
	if lock == nil {
		lock = &sync.Mutex{}
		s.building[key] = lock
	}
	s.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	s.mu.Lock()
	if b := s.bundles[key]; b != nil {
		if _, err := os.Stat(b.path); err == nil {
			s.mu.Unlock()
			return b, nil
		}
	}
	s.mu.Unlock()

	entry, image, label, ok := s.Entry(typ, version)
	if !ok {
		return nil, ErrUnknownType
	}
	priv, _, err := s.Repo.Key()
	if err != nil {
		return nil, fmt.Errorf("verteilschlüssel: %w", err)
	}
	if err := os.MkdirAll(s.Dir, 0o750); err != nil {
		return nil, err
	}
	imgPath := filepath.Join(s.Dir, key+".image.part")
	defer os.Remove(imgPath)
	if err := s.SaveImage(image, imgPath); err != nil {
		return nil, fmt.Errorf("image auf diesem Orchestrator nicht verfügbar: %w", err)
	}
	imageID, err := s.ImageID(image)
	if err != nil {
		return nil, err
	}
	tmp := filepath.Join(s.Dir, key+".build")
	defer os.Remove(tmp)
	sha, err := update.WriteBundle(tmp, update.BundleManifest{Format: update.BundleFormat, Type: typ, Version: version, Label: label,
		Image: image, ImageID: imageID, Entry: entry}, priv, imgPath)
	if err != nil {
		return nil, err
	}
	id := fmt.Sprintf("%s-%s", key, sha[:12])
	final := filepath.Join(s.Dir, id+".tar")
	if err := os.Rename(tmp, final); err != nil {
		return nil, err
	}
	b := &bundle{id: id, path: final, sha: sha, imageID: imageID}
	s.mu.Lock()
	s.bundles[key] = b
	s.mu.Unlock()
	return b, nil
}

// Run führt den Abgleich aus, bis ctx endet (unter runWhileLeader).
func (s *Service) Run(ctx context.Context) {
	s.init()
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		s.Reconcile(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.kick:
		}
	}
}

type response struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Detail string `json:"detail"`
}

func (s *Service) call(hostID string, payload map[string]any, timeout time.Duration) (response, error) {
	data, _ := json.Marshal(payload)
	raw, err := s.Request(fmt.Sprintf("omp.host.%s.cmd", hostID), data, timeout)
	if err != nil {
		return response{}, fmt.Errorf("keine Antwort: %w", err)
	}
	var r response
	if err := json.Unmarshal(raw, &r); err != nil {
		return response{}, fmt.Errorf("ungültige Antwort: %w", err)
	}
	return r, nil
}

// backoff: Wartezeit nach Fehlversuchen.
func backoff(attempts int) time.Duration {
	d := time.Duration(attempts) * 2 * time.Minute
	if d > 10*time.Minute {
		d = 10 * time.Minute
	}
	return d
}

// Reconcile arbeitet alle offenen Zeilen ab (höchstens Parallel gleichzeitig).
func (s *Service) Reconcile(ctx context.Context) {
	s.init()
	rows, err := s.Repo.List()
	if err != nil {
		slog.Warn("catalogdist: Zustand nicht lesbar", "error", err)
		return
	}
	// Drift erkennen: installierte Typen auf online-Hosts mit catalog-list gegenprüfen.
	s.verify(rows)
	rows, _ = s.Repo.List()

	sem := make(chan struct{}, s.Parallel)
	var wg sync.WaitGroup
	for _, r := range rows {
		if ctx.Err() != nil {
			break
		}
		if r.Desired == DesiredPresent && r.State == StateOK {
			continue
		}
		if r.State == StateFailed && time.Since(r.UpdatedAt) < backoff(r.Attempts) {
			continue
		}
		if !s.Online(r.HostID) {
			if r.State != StateOffline {
				_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateOffline, "Host meldet keine Telemetrie — wird nachgezogen, sobald er online ist", "", false)
			}
			continue
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(r Row) {
			defer func() { <-sem; wg.Done() }()
			if r.Desired == DesiredAbsent {
				s.remove(r)
			} else {
				s.install(r)
			}
		}(r)
	}
	wg.Wait()
}

func (s *Service) install(r Row) {
	fail := func(msg string) {
		slog.Warn("catalogdist: Installation fehlgeschlagen", "type", r.Type, "version", r.Version, "host", r.HostID, "error", msg)
		_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateFailed, msg, "", true)
	}
	_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateInstalling, "Bundle wird gebaut/übertragen …", "", false)
	b, err := s.ensureBundle(r.Type, r.Version)
	if err != nil {
		fail(err.Error())
		return
	}
	_, pub, err := s.Repo.Key()
	if err != nil {
		fail("verteilschlüssel: " + err.Error())
		return
	}
	resp, err := s.call(r.HostID, map[string]any{"action": "catalog-trust", "distKey": pub}, trustTimeout)
	if err != nil {
		fail(err.Error())
		return
	}
	if !resp.OK {
		fail("Verteilschlüssel nicht angenommen: " + resp.Error)
		return
	}
	token := s.Tokens.Issue(b.id)
	resp, err = s.call(r.HostID, map[string]any{
		"action": "catalog-install", "bundlePath": fmt.Sprintf("/api/v1/host-catalog/%s?token=%s", b.id, token), "bundleSha256": b.sha,
	}, installTimeout)
	if err != nil {
		fail(err.Error())
		return
	}
	if !resp.OK {
		fail(resp.Error)
		return
	}
	_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateOK, resp.Detail, b.imageID, false)
}

func (s *Service) remove(r Row) {
	_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateRemoving, "", "", false)
	resp, err := s.call(r.HostID, map[string]any{"action": "catalog-remove", "type": r.Type, "version": r.Version}, installTimeout)
	if err != nil {
		_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateFailed, err.Error(), "", true)
		return
	}
	if !resp.OK {
		_ = s.Repo.Set(r.Type, r.Version, r.HostID, StateFailed, resp.Error, "", true)
		return
	}
	_ = s.Repo.Delete(r.Type, r.Version, r.HostID)
}

// verify gleicht „ok“-Zeilen mit dem tatsächlichen Stand der Hosts ab (Host neu aufgesetzt, Installation entfernt).
func (s *Service) verify(rows []Row) {
	byHost := map[string][]Row{}
	for _, r := range rows {
		if r.Desired == DesiredPresent && r.State == StateOK {
			byHost[r.HostID] = append(byHost[r.HostID], r)
		}
	}
	for host, list := range byHost {
		s.mu.Lock()
		last := s.lastList[host]
		s.mu.Unlock()
		if time.Since(last) < verifyEvery || !s.Online(host) {
			continue
		}
		resp, err := s.call(host, map[string]any{"action": "catalog-list"}, listTimeout)
		if err != nil || !resp.OK {
			continue
		}
		s.mu.Lock()
		s.lastList[host] = time.Now()
		s.mu.Unlock()
		var have []struct{ Type, Version string }
		if json.Unmarshal([]byte(resp.Detail), &have) != nil {
			continue
		}
		has := map[string]bool{}
		for _, h := range have {
			has[strings.ToLower(h.Type)+"@"+h.Version] = true
		}
		for _, r := range list {
			if !has[strings.ToLower(r.Type)+"@"+r.Version] {
				_ = s.Repo.Set(r.Type, r.Version, host, StatePending, "auf dem Host nicht mehr vorhanden — wird neu installiert", "", false)
			}
		}
	}
}

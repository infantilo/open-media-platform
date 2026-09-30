package main

// System-Update (docs/ENTWURF-SYSTEM-UPDATE.md): der Supervisor wendet ein
// vom Orchestrator geprüft abgelegtes Update-Paket an. Er prüft es selbst
// noch einmal (Struktur, SHA-256, Ed25519-Signatur) und vertraut dem
// Orchestrator nicht blind — der wird ja gerade ersetzt.
//
// Ablauf: prüfen → alles neben dem Ziel bereitstellen (`*.update-new`,
// noch OHNE Downtime) → stop-omp.sh → Dateien tauschen (Vorgänger nach
// `<updateDir>/rollback/<ts>/`) → start-omp.sh (OMP_SKIP_BUILD=1) →
// Gesundheits-/Versionsprüfung → bei Fehler automatischer Rollback.
// Laufende Node-Prozesse werden nicht angefasst; sie behalten ihre alte
// Inode und laufen weiter (Markierung „veraltet“ macht der Orchestrator).
// Der Supervisor tauscht sich selbst zuletzt per exec aus (gleiche PID).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

type updater struct {
	srv           *server
	rootDir       string
	updateDir     string
	keyFile       string
	allowUnsigned bool
	catalogPath   string
	orchURL       string
	verifyTimeout time.Duration
	keepRollbacks int
	// execSelf ersetzt den Prozess durch das neue Supervisor-Binary
	// (in Tests ersetzbar).
	execSelf func(path string) error
}

func newUpdater(srv *server, rootDir string) *updater {
	return &updater{
		srv:           srv,
		rootDir:       rootDir,
		updateDir:     envOr("OMP_UPDATE_DIR", filepath.Join(rootDir, ".updates")),
		keyFile:       envOr("OMP_UPDATE_PUBKEY_FILE", filepath.Join(rootDir, ".run", "update-trusted.pub")),
		allowUnsigned: strings.EqualFold(envOr("OMP_UPDATE_ALLOW_UNSIGNED", "false"), "true"),
		catalogPath:   envOr("OMP_CATALOG_PATH", filepath.Join(rootDir, "deploy", "catalog.json")),
		orchURL:       envOr("OMP_ORCHESTRATOR_URL", "http://127.0.0.1:8000"),
		verifyTimeout: 90 * time.Second,
		keepRollbacks: 3,
		execSelf: func(path string) error {
			return syscall.Exec(path, os.Args, os.Environ())
		},
	}
}

type updateRequest struct {
	File string `json:"file"`
}

func (s *server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var req updateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	u := s.upd
	pkgPath, err := u.resolvePackage(req.File)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Vorab prüfen, BEVOR der Vorgang beginnt: ein ungültiges Paket wird
	// mit einer klaren Antwort abgelehnt, nicht erst im Hintergrund.
	pkg, err := u.readPackage(pkgPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Paket ungültig: %s", err), http.StatusBadRequest)
		return
	}
	plan, err := u.plan(pkg.Manifest)
	if err != nil {
		http.Error(w, fmt.Sprintf("Paket nicht anwendbar: %s", err), http.StatusBadRequest)
		return
	}
	if !s.status.beginKind("update", filepath.Base(pkgPath), pkg.Manifest.Version, "staging") {
		http.Error(w, "ein Restore oder Update läuft bereits", http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "update eingeleitet"})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go u.run(pkgPath, pkg, plan)
}

// resolvePackage: nur reguläre .tar.gz-Dateien direkt im Update-Verzeichnis.
func (u *updater) resolvePackage(file string) (string, error) {
	if file == "" {
		return "", errors.New("file fehlt")
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return "", err
	}
	dir, err := filepath.Abs(u.updateDir)
	if err != nil {
		return "", err
	}
	if filepath.Dir(abs) != dir || !strings.HasSuffix(abs, ".tar.gz") {
		return "", fmt.Errorf("paket muss direkt in %s liegen", dir)
	}
	st, err := os.Lstat(abs)
	if err != nil {
		return "", fmt.Errorf("paket nicht gefunden: %w", err)
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("paket ist keine reguläre Datei")
	}
	return abs, nil
}

func (u *updater) readPackage(path string) (*update.Package, error) {
	keys, err := update.LoadPublicKeys(u.keyFile)
	if err != nil {
		return nil, fmt.Errorf("vertrauenswürdige Schlüssel lesen: %w", err)
	}
	return update.ReadPackage(path, update.Options{
		Trusted: keys, AllowUnsigned: u.allowUnsigned, Arch: runtime.GOOS + "/" + runtime.GOARCH,
	})
}

// planItem: eine Komponente mit allen Zielpfaden.
type planItem struct {
	comp  update.Component
	dests []string
}

func (u *updater) plan(m update.Manifest) ([]planItem, error) {
	var out []planItem
	for _, c := range m.Components {
		dests, err := u.resolveTarget(c.Target)
		if err != nil {
			return nil, fmt.Errorf("komponente %s: %w", c.ID, err)
		}
		out = append(out, planItem{comp: c, dests: dests})
	}
	return out, nil
}

func (u *updater) resolveTarget(target string) ([]string, error) {
	if err := update.CheckTarget(target); err != nil {
		return nil, err
	}
	switch {
	case update.FixedTargets[target]:
		return []string{filepath.Join(u.rootDir, filepath.FromSlash(target))}, nil
	case strings.HasPrefix(target, "ui/dist/"):
		base := filepath.Join(u.rootDir, "ui", "dist")
		dest := filepath.Join(u.rootDir, filepath.FromSlash(target))
		if rel, err := filepath.Rel(base, dest); err != nil || strings.HasPrefix(rel, "..") {
			return nil, fmt.Errorf("ziel %q verlässt ui/dist", target)
		}
		return []string{dest}, nil
	default: // node:<name>
		return u.resolveNode(strings.TrimPrefix(target, "node:"))
	}
}

// resolveNode bildet einen Node-Namen über den Katalog auf die
// tatsächlichen Binary-Pfade ab (relativ zu <root>/orchestrator, dem
// Arbeitsverzeichnis des Orchestrators/Launchers).
func (u *updater) resolveNode(name string) ([]string, error) {
	data, err := os.ReadFile(u.catalogPath)
	if err != nil {
		return nil, fmt.Errorf("katalog lesen: %w", err)
	}
	var cat []struct {
		Type    string   `json:"type"`
		Runner  string   `json:"runner"`
		Command []string `json:"command"`
	}
	if err := json.Unmarshal(data, &cat); err != nil {
		return nil, fmt.Errorf("katalog ungültig: %w", err)
	}
	seen := map[string]bool{}
	var dests []string
	for _, e := range cat {
		if len(e.Command) == 0 || filepath.Base(e.Command[0]) != name {
			continue
		}
		p := e.Command[0]
		if !filepath.IsAbs(p) {
			p = filepath.Join(u.rootDir, "orchestrator", p)
		}
		p = filepath.Clean(p)
		if !seen[p] {
			seen[p] = true
			dests = append(dests, p)
		}
	}
	if len(dests) == 0 {
		return nil, fmt.Errorf("node %q steht nicht im Katalog", name)
	}
	return dests, nil
}

type swapped struct {
	dest   string
	backup string // "" = Datei existierte vorher nicht
}

func (u *updater) run(pkgPath string, pkg *update.Package, plan []planItem) {
	from := u.currentVersion()
	res := u.doUpdate(pkgPath, pkg, plan)
	u.srv.status.finish(res.err)
	u.saveLastStatus()
	u.appendHistory(historyEntry{
		Time: time.Now().UTC(), From: from, Version: pkg.Manifest.Version,
		Ok: res.err == nil, RolledBack: res.rolledBack, Error: errString(res.err),
	})
	if res.err != nil {
		slog.Error("supervisor: update failed", "version", pkg.Manifest.Version, "error", res.err, "rolledBack", res.rolledBack)
		return
	}
	slog.Info("supervisor: update succeeded", "version", pkg.Manifest.Version)
	u.pruneRollbacks()
	if res.selfDest != "" {
		slog.Info("supervisor: ersetze mich durch das neue Binary", "path", res.selfDest)
		if err := u.execSelf(res.selfDest); err != nil {
			slog.Error("supervisor: exec des neuen Supervisors fehlgeschlagen — laufe mit dem alten weiter", "error", err)
		}
	}
}

type updateResult struct {
	err        error
	rolledBack bool
	selfDest   string
}

func (u *updater) doUpdate(pkgPath string, pkg *update.Package, plan []planItem) updateResult {
	st := u.srv.status
	m := pkg.Manifest

	// 1. Bereitstellen — noch keine Downtime.
	st.setPhase("staging")
	var staged []struct{ dest, tmp string }
	cleanup := func() {
		for _, s := range staged {
			_ = os.Remove(s.tmp)
		}
	}
	for _, it := range plan {
		mode := os.FileMode(0o644)
		if update.IsExecutableTarget(it.comp.Target) {
			mode = 0o755
		}
		for _, dest := range it.dests {
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				cleanup()
				return updateResult{err: fmt.Errorf("verzeichnis für %s: %w", dest, err)}
			}
			tmp := dest + ".update-new"
			if err := update.ExtractFile(pkgPath, it.comp.Path, it.comp.SHA256, tmp, mode); err != nil {
				cleanup()
				return updateResult{err: fmt.Errorf("bereitstellen %s: %w", it.comp.ID, err)}
			}
			staged = append(staged, struct{ dest, tmp string }{dest, tmp})
		}
	}

	// 2. Stoppen.
	st.setPhase("stopping")
	slog.Info("supervisor: stopping orchestrator for update", "script", u.srv.stopScript)
	time.Sleep(sleepBeforeStop)
	if out, err := exec.Command(u.srv.stopScript).CombinedOutput(); err != nil {
		cleanup()
		return updateResult{err: fmt.Errorf("stop-omp.sh: %w (%s)", err, strings.TrimSpace(string(out)))}
	}

	// 3. Tauschen.
	st.setPhase("swapping")
	rbDir := filepath.Join(u.updateDir, "rollback", time.Now().UTC().Format("20060102T150405Z"))
	var done []swapped
	fail := func(err error) updateResult {
		return u.rollback(fmt.Errorf("%w", err), done, staged, m)
	}
	for _, s := range staged {
		bk := ""
		if _, err := os.Stat(s.dest); err == nil {
			bk = filepath.Join(rbDir, backupName(s.dest))
			if err := os.MkdirAll(rbDir, 0o750); err != nil {
				return fail(err)
			}
			if err := copyFile(s.dest, bk); err != nil {
				return fail(fmt.Errorf("sichern %s: %w", s.dest, err))
			}
		}
		if err := os.Rename(s.tmp, s.dest); err != nil {
			return fail(fmt.Errorf("tauschen %s: %w", s.dest, err))
		}
		done = append(done, swapped{dest: s.dest, backup: bk})
	}
	u.writeRollbackIndex(rbDir, done)

	// 4. Starten + 5. Prüfen.
	st.setPhase("starting")
	if err := u.startOrchestrator(); err != nil {
		return u.rollback(err, done, nil, m)
	}
	st.setPhase("verifying")
	if err := u.waitVersion(m.Version); err != nil {
		return u.rollback(err, done, nil, m)
	}

	res := updateResult{}
	if self := selfDestOf(plan, u.rootDir); self != "" {
		res.selfDest = self
	}
	return res
}

func selfDestOf(plan []planItem, rootDir string) string {
	for _, it := range plan {
		if it.comp.Target == "bin/omp-supervisor" && len(it.dests) > 0 {
			return it.dests[0]
		}
	}
	return ""
}

func (u *updater) startOrchestrator() error {
	cmd := exec.Command(u.srv.startScript)
	cmd.Env = append(os.Environ(), "OMP_SKIP_BUILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("start-omp.sh: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// rollback stellt den vorherigen Stand her und startet ihn wieder.
func (u *updater) rollback(cause error, done []swapped, staged []struct{ dest, tmp string }, m update.Manifest) updateResult {
	st := u.srv.status
	st.setPhase("rolling-back")
	slog.Error("supervisor: update fehlgeschlagen, rolle zurück", "error", cause)
	for _, s := range staged {
		_ = os.Remove(s.tmp)
	}
	_, _ = exec.Command(u.srv.stopScript).CombinedOutput()
	var restoreErrs []string
	for i := len(done) - 1; i >= 0; i-- {
		d := done[i]
		if d.backup == "" {
			_ = os.Remove(d.dest)
			continue
		}
		tmp := d.dest + ".rollback-new"
		if err := copyFile(d.backup, tmp); err == nil {
			err = os.Rename(tmp, d.dest)
			if err != nil {
				restoreErrs = append(restoreErrs, fmt.Sprintf("%s: %v", d.dest, err))
			}
		} else {
			restoreErrs = append(restoreErrs, fmt.Sprintf("%s: %v", d.dest, err))
		}
	}
	msg := cause.Error()
	if len(restoreErrs) > 0 {
		msg += " — ROLLBACK UNVOLLSTÄNDIG: " + strings.Join(restoreErrs, "; ")
	}
	if err := u.startOrchestrator(); err != nil {
		msg += " — alter Stand konnte nicht gestartet werden: " + err.Error()
	} else if err := u.waitHealthy(); err != nil {
		msg += " — alter Stand meldet sich nicht gesund: " + err.Error()
	} else {
		msg += " — vorheriger Stand wiederhergestellt und läuft"
	}
	if len(m.Migrations) > 0 {
		msg += fmt.Sprintf(". ACHTUNG: dieses Update enthält Datenbank-Migrationen (%s); falls sie bereits angewendet wurden, ist das Schema neuer als das alte Binary — Backup über Backup/Restore einspielen", strings.Join(m.Migrations, ", "))
	}
	return updateResult{err: errors.New(msg), rolledBack: true}
}

// ---- Gesundheit -----------------------------------------------------------

func (u *updater) httpGet(path string) ([]byte, int, error) {
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(strings.TrimRight(u.orchURL, "/") + path)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	return b, resp.StatusCode, nil
}

func (u *updater) currentVersion() string {
	b, code, err := u.httpGet("/api/v1/version")
	if err != nil || code != http.StatusOK {
		return ""
	}
	var v struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(b, &v)
	return v.Version
}

func (u *updater) waitHealthy() error {
	deadline := time.Now().Add(u.verifyTimeout)
	var last error
	for time.Now().Before(deadline) {
		if _, code, err := u.httpGet("/healthz"); err == nil && code == http.StatusOK {
			return nil
		} else if err != nil {
			last = err
		} else {
			last = fmt.Errorf("healthz %d", code)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("kein gesunder Start innerhalb %s: %v", u.verifyTimeout, last)
}

func (u *updater) waitVersion(want string) error {
	deadline := time.Now().Add(u.verifyTimeout)
	var last string
	for time.Now().Before(deadline) {
		if _, code, err := u.httpGet("/healthz"); err == nil && code == http.StatusOK {
			if got := u.currentVersion(); got == want {
				return nil
			} else {
				last = fmt.Sprintf("Version %q", got)
			}
		} else if err != nil {
			last = err.Error()
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("neuer Stand nicht bestätigt (erwartet Version %q, zuletzt %s) innerhalb %s", want, last, u.verifyTimeout)
}

// ---- Rollback-Ablage, Historie, Status -----------------------------------------

func backupName(dest string) string {
	sum := sha256.Sum256([]byte(dest))
	return hex.EncodeToString(sum[:6]) + "-" + filepath.Base(dest)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (u *updater) writeRollbackIndex(dir string, done []swapped) {
	type row struct {
		Dest   string `json:"dest"`
		Backup string `json:"backup,omitempty"`
	}
	var rows []row
	for _, d := range done {
		rows = append(rows, row{d.dest, d.backup})
	}
	if data, err := json.MarshalIndent(rows, "", "  "); err == nil {
		_ = os.MkdirAll(dir, 0o750)
		_ = os.WriteFile(filepath.Join(dir, "index.json"), data, 0o640)
	}
}

func (u *updater) pruneRollbacks() {
	root := filepath.Join(u.updateDir, "rollback")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > u.keepRollbacks {
		_ = os.RemoveAll(filepath.Join(root, names[0]))
		names = names[1:]
	}
}

type historyEntry struct {
	Time       time.Time `json:"time"`
	From       string    `json:"from,omitempty"`
	Version    string    `json:"version"`
	Ok         bool      `json:"ok"`
	RolledBack bool      `json:"rolledBack,omitempty"`
	Error      string    `json:"error,omitempty"`
}

func (u *updater) appendHistory(h historyEntry) {
	path := filepath.Join(u.updateDir, "history.json")
	var all []historyEntry
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &all)
	}
	all = append(all, h)
	if len(all) > 50 {
		all = all[len(all)-50:]
	}
	if data, err := json.MarshalIndent(all, "", "  "); err == nil {
		_ = os.MkdirAll(u.updateDir, 0o750)
		tmp := path + ".tmp"
		if os.WriteFile(tmp, data, 0o640) == nil {
			_ = os.Rename(tmp, path)
		}
	}
}

// saveLastStatus/loadLastStatus: das Ergebnis überlebt den exec des neuen
// Supervisors (GET /status zeigt es danach weiter an).
func (u *updater) saveLastStatus() {
	snap := u.srv.status.snapshot()
	if data, err := json.Marshal(snap); err == nil {
		_ = os.MkdirAll(u.updateDir, 0o750)
		_ = os.WriteFile(filepath.Join(u.updateDir, "supervisor-status.json"), data, 0o640)
	}
}

func (u *updater) loadLastStatus() {
	data, err := os.ReadFile(filepath.Join(u.updateDir, "supervisor-status.json"))
	if err != nil {
		return
	}
	var snap statusData
	if json.Unmarshal(data, &snap) == nil && !snap.Busy {
		u.srv.status.mu.Lock()
		u.srv.status.data = snap
		u.srv.status.mu.Unlock()
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

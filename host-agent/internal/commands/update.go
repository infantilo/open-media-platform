package commands

// System-Update auf einem Remote-Host (docs/ENTWURF-SYSTEM-UPDATE.md, §6):
// der Orchestrator schickt `action:"update"` mit einem Pfad + Einmal-Token
// zum Paket-Download. Der Agent lädt das Paket NUR vom eigenen
// Orchestrator (updatePath wird an OMP_ORCHESTRATOR_URL gehängt, nie eine
// frei übermittelte URL), prüft es vollständig mit seinem EIGENEN
// Vertrauensanker (Struktur, SHA-256, Ed25519 — der Orchestrator wird nicht
// blind geglaubt) und ersetzt danach nur, was auf DIESEM Host existiert:
// das eigene Binary (`bin/omp-host-agent`) und Node-Binaries, die im
// agent-lokalen Katalog stehen (`node:<name>`). Orchestrator-/Supervisor-/
// UI-Komponenten des Pakets gehören auf den Orchestrator-Host und werden
// hier ignoriert. KEIN Neustart: der Agent verwaltet seine Kindprozesse im
// Speicher, ein exec würde sie verwaisen lassen — das neue Agent-Binary
// wird beim nächsten Agent-Neustart aktiv (Detail-Text der Antwort).

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

// UpdateConfig konfiguriert den Update-Pfad des Agents.
type UpdateConfig struct {
	// KeyFile: vertrauenswürdige Ed25519-Public-Keys (einer pro Zeile).
	KeyFile string
	// AllowUnsigned nur für die Entwicklung.
	AllowUnsigned bool
	// SelfPath: Pfad des laufenden Agent-Binarys (wird ersetzt).
	SelfPath string
	// Dir: Arbeitsverzeichnis (Downloads, Rollback-Kopien).
	Dir string
}

// SetUpdateConfig aktiviert den Update-Befehl. Ohne Aufruf lehnt der
// Agent `update` ab.
func (e *Executor) SetUpdateConfig(c UpdateConfig) { e.upd = &c }

func (e *Executor) update(req Request) Response {
	c := e.upd
	if c == nil {
		return Response{Error: "update auf diesem Host nicht konfiguriert (OMP_UPDATE_PUBKEY_FILE)"}
	}
	if req.UpdatePath == "" || req.UpdateSHA256 == "" || req.UpdateVersion == "" {
		return Response{Error: "updatePath/updateSha256/updateVersion erforderlich"}
	}
	if !strings.HasPrefix(req.UpdatePath, "/api/v1/host-updates/") || strings.Contains(req.UpdatePath, "..") {
		return Response{Error: "updatePath nicht erlaubt"}
	}
	base, err := url.Parse(e.orchestratorURL)
	if err != nil || base.Host == "" {
		return Response{Error: "kein gültiger Orchestrator-URL konfiguriert"}
	}
	target := strings.TrimRight(e.orchestratorURL, "/") + req.UpdatePath

	if err := os.MkdirAll(c.Dir, 0o750); err != nil {
		return Response{Error: err.Error()}
	}
	pkgPath := filepath.Join(c.Dir, "download-"+req.UpdateVersion+".tar.gz")
	defer os.Remove(pkgPath)
	if err := download(target, pkgPath, req.UpdateSHA256); err != nil {
		return Response{Error: "download: " + err.Error()}
	}

	keys, err := update.LoadPublicKeys(c.KeyFile)
	if err != nil {
		return Response{Error: "vertrauenswürdige Schlüssel: " + err.Error()}
	}
	pkg, err := update.ReadPackage(pkgPath, update.Options{Trusted: keys, AllowUnsigned: c.AllowUnsigned, Arch: runtime.GOOS + "/" + runtime.GOARCH})
	if err != nil {
		return Response{Error: "paket ungültig: " + err.Error()}
	}
	if pkg.Manifest.Version != req.UpdateVersion {
		return Response{Error: fmt.Sprintf("paket enthält Version %q, erwartet %q", pkg.Manifest.Version, req.UpdateVersion)}
	}

	type item struct {
		comp  update.Component
		dests []string
	}
	var plan []item
	for _, comp := range pkg.Manifest.Components {
		switch {
		case comp.Target == "bin/omp-host-agent":
			if c.SelfPath != "" {
				plan = append(plan, item{comp, []string{c.SelfPath}})
			}
		case strings.HasPrefix(comp.Target, "node:"):
			name := strings.TrimPrefix(comp.Target, "node:")
			var dests []string
			seen := map[string]bool{}
			for _, ent := range e.catalog {
				if len(ent.Command) == 0 || filepath.Base(ent.Command[0]) != name {
					continue
				}
				p := filepath.Clean(ent.Command[0])
				if !seen[p] {
					seen[p] = true
					dests = append(dests, p)
				}
			}
			if len(dests) > 0 {
				plan = append(plan, item{comp, dests})
			}
		}
	}
	if len(plan) == 0 {
		return Response{OK: true, Detail: "nichts anzuwenden: das Paket enthält nichts für diesen Host (Host-Agent-Binary/Nodes aus dem lokalen Katalog)"}
	}

	// Bereitstellen (noch nichts ersetzt).
	type staged struct{ dest, tmp string }
	var stg []staged
	cleanup := func() {
		for _, s := range stg {
			_ = os.Remove(s.tmp)
		}
	}
	for _, it := range plan {
		for _, dest := range it.dests {
			tmp := dest + ".update-new"
			if err := update.ExtractFile(pkgPath, it.comp.Path, it.comp.SHA256, tmp, 0o755); err != nil {
				cleanup()
				return Response{Error: fmt.Sprintf("bereitstellen %s: %v", it.comp.ID, err)}
			}
			stg = append(stg, staged{dest, tmp})
		}
	}

	// Tauschen, Vorgänger sichern; bei Fehler alles zurück.
	rbDir := filepath.Join(c.Dir, "rollback", time.Now().UTC().Format("20060102T150405Z"))
	type swapped struct{ dest, backup string }
	var done []swapped
	undo := func(cause error) Response {
		cleanup()
		for i := len(done) - 1; i >= 0; i-- {
			d := done[i]
			if d.backup == "" {
				_ = os.Remove(d.dest)
				continue
			}
			tmp := d.dest + ".rollback-new"
			if copyFile(d.backup, tmp) == nil {
				_ = os.Rename(tmp, d.dest)
			}
		}
		return Response{Error: cause.Error() + " — zurückgerollt"}
	}
	for _, s := range stg {
		bk := ""
		if _, err := os.Stat(s.dest); err == nil {
			bk = filepath.Join(rbDir, fmt.Sprintf("%d-%s", len(done), filepath.Base(s.dest)))
			if err := copyFile(s.dest, bk); err != nil {
				return undo(fmt.Errorf("sichern %s: %w", s.dest, err))
			}
		}
		if err := os.Rename(s.tmp, s.dest); err != nil {
			return undo(fmt.Errorf("tauschen %s: %w", s.dest, err))
		}
		done = append(done, swapped{s.dest, bk})
	}
	var names []string
	agentReplaced := false
	for _, d := range done {
		names = append(names, filepath.Base(d.dest))
		if d.dest == c.SelfPath {
			agentReplaced = true
		}
	}
	detail := fmt.Sprintf("Version %s: ersetzt %s", pkg.Manifest.Version, strings.Join(names, ", "))
	if agentReplaced {
		detail += " — Host-Agent-Neustart nötig, damit das neue Agent-Binary aktiv wird"
	}
	detail += "; laufende Instanzen behalten den alten Stand bis zu ihrem Neustart"
	return Response{OK: true, Detail: detail}
}

func download(target, dst, wantSHA string) error {
	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Get(target)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, update.MaxFileBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n > update.MaxFileBytes {
		return errors.New("paket zu groß")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return fmt.Errorf("Prüfsumme stimmt nicht (erwartet %s, erhalten %s)", wantSHA, got)
	}
	return nil
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

// ---- Markierung veralteter Instanzen ---------------------------------------

// processStartTime liest den Startzeitpunkt eines Prozesses aus /proc
// (Feld 22 von /proc/<pid>/stat, Ticks seit Boot bei 100 Hz, plus btime).
func processStartTime(pid int) (time.Time, bool) {
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return time.Time{}, false
	}
	s := string(stat)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return time.Time{}, false
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 20 {
		return time.Time{}, false
	}
	var ticks int64
	if _, err := fmt.Sscan(fields[19], &ticks); err != nil {
		return time.Time{}, false
	}
	procStat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, false
	}
	for _, line := range strings.Split(string(procStat), "\n") {
		if rest, ok := strings.CutPrefix(line, "btime "); ok {
			var btime int64
			if _, err := fmt.Sscan(strings.TrimSpace(rest), &btime); err != nil {
				return time.Time{}, false
			}
			return time.Unix(btime, 0).Add(time.Duration(ticks) * 10 * time.Millisecond), true
		}
	}
	return time.Time{}, false
}

// binaryNewerThanProcess: das Binary unter path wurde nach dem Start von
// pid ersetzt.
func binaryNewerThanProcess(path string, pid int) bool {
	bin, err := os.Stat(path)
	if err != nil {
		return false
	}
	start, ok := processStartTime(pid)
	return ok && bin.ModTime().After(start)
}

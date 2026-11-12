package jobs

// Sandbox für ffmpeg/ffprobe-Jobs (HAERTUNG-PLAN.md 98.3, M4): der häufigste Parser für Fremddaten läuft nicht mehr mit den
// Rechten des Agents, sondern in einem rootless Container: kein Netz (außer `allowNet`), Wurzel nur lesbar, Medien nur lesbar,
// nur Arbeits- und Zielverzeichnis schreibbar, alle Capabilities weg, `no-new-privileges`, Standard-seccomp-Profil von Podman,
// PID- und Speichergrenze, Nutzer ≠ root (gleiche UID wie der Agent über `--userns=keep-id`, damit Ergebnisdateien dem
// Betreiber gehören), **kein MXL und keine Plattform-Dateien**. Vorgabe je Programm in tools.json: "sandbox": "container".
// Zweite, schnellere Stufe: "sandbox": "namespace" — dasselbe Hüllenprinzip mit bubblewrap statt Container-Laufzeit (Start in
// Millisekunden statt rund 1,5 s, nutzt das ffmpeg des Hosts, kein Image nötig; dafür ohne das Standard-seccomp-Profil von Podman).
// Standard ist `none` — ohne Eintrag ändert sich nichts.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// PodmanBinary ist der aufgerufene Podman-Befehl (Tests setzen ein Fake-Skript).
var PodmanBinary = "podman"

const (
	sandboxLabel        = "omp-job=1"
	defaultSandboxPids  = 512
	defaultSandboxMemMB = 8192
	defaultSandboxTmpMB = 512
	containerNamePrefix = "omp-job-"
)

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// sandboxed: läuft dieses Programm im Container?
func (tc ToolConfig) sandboxed() bool { return tc.Sandbox == "container" }

// namespaced: läuft dieses Programm in einer bubblewrap-Hülle (Namensräume, kein Container)?
func (tc ToolConfig) namespaced() bool { return tc.Sandbox == "namespace" }

// BwrapBinary ist der aufgerufene bubblewrap-Befehl (Tests setzen ein Fake-Skript).
var BwrapBinary = "bwrap"

// namespaceEtc: Systemdateien, die das Programm braucht (Bibliotheks-Cache, Schriften, Zeitzone) — nicht /etc als Ganzes.
var namespaceEtc = []string{"/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/alternatives", "/etc/fonts", "/etc/localtime", "/etc/ssl/certs"}

// bwrapArgs liefert die bubblewrap-Argumente für einen Job (ohne etwas zu starten — testbar). Danach folgen Programm und Argumente.
// Ohne `--new-session`: der Job bleibt in der Prozessgruppe des Agents, damit Pause (SIGSTOP), Abbruch und Renice weiter über die
// Gruppe wirken; es gibt kein Terminal, in das etwas eingeschleust werden könnte.
func (r *Runner) bwrapArgs(tool string, tc ToolConfig, args []string, workDir string) []string {
	a := []string{"--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
		"--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
		"--ro-bind", "/usr", "/usr"}
	if r.cfg.AllowNet {
		a = append(a, "--share-net")
	}
	for _, d := range []string{"/bin", "/sbin", "/lib", "/lib32", "/lib64"} {
		if fi, err := os.Lstat(d); err == nil {
			if fi.Mode()&os.ModeSymlink != 0 { // zusammengelegtes /usr: Verweis nachbilden
				if tgt, err := os.Readlink(d); err == nil {
					a = append(a, "--symlink", tgt, d)
				}
			} else {
				a = append(a, "--ro-bind", d, d)
			}
		}
	}
	for _, f := range namespaceEtc {
		a = append(a, "--ro-bind-try", f, f)
	}
	if dir := filepath.Dir(tc.Path); !strings.HasPrefix(dir, "/usr/") && dir != "/usr" && !strings.HasPrefix(dir, "/bin") {
		a = append(a, "--ro-bind-try", dir, dir) // Programm außerhalb von /usr (z. B. /opt/ffmpeg)
	}
	a = append(a, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp")
	mode := map[string]string{}
	for _, root := range r.cfg.JobRoots {
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			mode[root] = "ro"
		}
	}
	mode[workDir] = "rw"
	for _, d := range r.writableDirs(args) {
		mode[d] = "rw"
	}
	dests := make([]string, 0, len(mode))
	for d := range mode {
		dests = append(dests, d)
	}
	sort.Strings(dests)
	for _, d := range dests { // Eltern vor Kindern: sortiert nach Pfad
		flag := "--ro-bind"
		if mode[d] == "rw" {
			flag = "--bind"
		}
		a = append(a, flag, d, d)
	}
	a = append(a, "--chdir", workDir, tc.Path)
	return append(a, args...)
}

// containerName ist der Name des Job-Containers (zum Pausieren, Abbrechen, Aufräumen).
func containerName(jobID string) string {
	return containerNamePrefix + unsafeName.ReplaceAllString(jobID, "_")
}

func (c Config) sandboxMemMB() int {
	if c.SandboxMemoryMB > 0 {
		return c.SandboxMemoryMB
	}
	return defaultSandboxMemMB
}

func (c Config) sandboxPids() int {
	if c.SandboxPids > 0 {
		return c.SandboxPids
	}
	return defaultSandboxPids
}

// anySandbox: ist mindestens ein Programm für die Sandbox vorgesehen?
func (c Config) anySandbox() bool {
	for _, t := range c.Tools {
		if t.sandboxed() {
			return true
		}
	}
	return false
}

// cpusFromQuota macht aus "200%" die Zahl 2 für `--cpus` (0 = keine Grenze, auch bei nicht lesbarer Angabe).
func cpusFromQuota(q string) float64 {
	q = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(q), "%"))
	v, err := strconv.ParseFloat(q, 64)
	if err != nil || v <= 0 {
		return 0
	}
	return v / 100
}

// writableDirs bestimmt, welche Verzeichnisse beschreibbar eingehängt werden: das Elternverzeichnis jedes absoluten Pfads
// unter den Wurzeln, der noch NICHT existiert (eine Ausgabe; vorhandene Pfade sind Eingaben und bleiben nur lesbar). Ausgaben,
// die schon da sind, werden an zwei Merkmalen erkannt: der Endung `.part` (Ausgaben entstehen immer als `<name>.part`, ein
// abgebrochener früherer Lauf lässt sie zurück) und — bei `-y` — dem letzten Argument. Sonst scheiterte jede Wiederholung eines
// Jobs auf demselben Host an „Read-only file system“. Das Arbeitsverzeichnis kommt getrennt dazu.
func (r *Runner) writableDirs(args []string) []string {
	seen := map[string]bool{}
	var out []string
	overwrite := false
	for _, a := range args {
		if a == "-y" {
			overwrite = true
		}
	}
	for i, a := range args {
		p := a
		if m := schemeRe.FindString(a); m != "" && len(m) > 2 && strings.EqualFold(strings.TrimSuffix(m, ":"), "file") {
			p = strings.TrimPrefix(strings.TrimPrefix(a, m), "//")
		}
		if !filepath.IsAbs(p) || !r.underRoot(p) {
			continue
		}
		if _, err := os.Lstat(p); err == nil {
			isOutput := strings.HasSuffix(p, ".part") || (overwrite && i == len(args)-1)
			if !isOutput {
				continue // vorhanden = Eingabe
			}
		}
		d := filepath.Dir(p)
		if st, err := os.Stat(d); err == nil && st.IsDir() && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out
}

// sandboxArgs liefert die `podman`-Argumente für einen Job (ohne etwas zu starten — testbar).
func (r *Runner) sandboxArgs(jobID, tool string, args []string, nice int, workDir string, uid, gid int) []string {
	cfg := r.cfg
	a := []string{
		"run", "--rm", "--name", containerName(jobID), "--label", sandboxLabel,
		"--pull=never", "--log-driver=none", "--read-only",
		"--tmpfs", fmt.Sprintf("/tmp:rw,nosuid,nodev,size=%dm", defaultSandboxTmpMB),
		"--cap-drop=all", "--security-opt=no-new-privileges",
		"--pids-limit", strconv.Itoa(cfg.sandboxPids()),
		"--memory", fmt.Sprintf("%dm", cfg.sandboxMemMB()), "--memory-swap", fmt.Sprintf("%dm", cfg.sandboxMemMB()),
		"--userns=keep-id", "--user", fmt.Sprintf("%d:%d", uid, gid),
		"-e", "HOME=/tmp", "-w", workDir,
	}
	if !cfg.AllowNet {
		a = append(a, "--network=none")
	}
	if c := cpusFromQuota(cfg.CPUQuota); c > 0 {
		a = append(a, "--cpus", strconv.FormatFloat(c, 'f', -1, 64))
	}
	// Einhängepunkte: Wurzeln nur lesbar; Arbeits- und Zielverzeichnisse schreibbar (schreibbar gewinnt bei gleichem Ziel).
	mode := map[string]string{}
	for _, root := range cfg.JobRoots {
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			mode[root] = "ro"
		}
	}
	mode[workDir] = "rw"
	for _, d := range r.writableDirs(args) {
		mode[d] = "rw"
	}
	dests := make([]string, 0, len(mode))
	for d := range mode {
		dests = append(dests, d)
	}
	sort.Strings(dests)
	for _, d := range dests {
		a = append(a, "-v", d+":"+d+":"+mode[d])
	}
	a = append(a, cfg.SandboxImage, "nice", "-n", strconv.Itoa(nice), tool)
	return append(a, args...)
}

// sandboxToolCmd: Kommando für Auskunftsaufrufe (Version, Encoderliste) im Container (Probe) — ohne Job-Verzeichnisse.
func (r *Runner) sandboxToolCmd(tool string, args ...string) *exec.Cmd {
	a := []string{"run", "--rm", "--pull=never", "--log-driver=none", "--network=none", "--read-only", "--cap-drop=all",
		"--security-opt=no-new-privileges", "--pids-limit", "64", "--memory", "512m", r.cfg.SandboxImage, tool}
	return exec.Command(PodmanBinary, append(a, args...)...)
}

// toolCmd: Kommando für ein Programm — im Container, wenn für dieses Programm vorgesehen, sonst direkt.
func (r *Runner) toolCmd(name string, tc ToolConfig, args ...string) *exec.Cmd {
	if tc.sandboxed() {
		return r.sandboxToolCmd(name, args...)
	}
	return exec.Command(tc.Path, args...)
}

// removeContainer räumt einen Job-Container weg (Abbruch, der Client-Prozess ist schon beendet oder hängt).
func removeContainer(name string) {
	_ = exec.Command(PodmanBinary, "rm", "-f", "-t", "0", name).Run()
}

// cleanupContainers entfernt Job-Container, die ein abgestürzter Vorgänger zurückgelassen hat; liefert die Anzahl.
func cleanupContainers() int {
	out, err := exec.Command(PodmanBinary, "ps", "-aq", "--filter", "label="+sandboxLabel).Output()
	if err != nil {
		return 0
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return 0
	}
	_ = exec.Command(PodmanBinary, append([]string{"rm", "-f", "-t", "0"}, ids...)...).Run()
	return len(ids)
}

package podmanrun

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// Abgeschottete MXL-Domains (Kap. 103, Entwurf D7): Ein Node in einer abgeschotteten Domain läuft in einem eigenen User- und
// Mount-Namespace (`unshare --user --map-root-user --mount`). Darin ist /dev/shm ein leeres, privates tmpfs, in das nur die
// Domain-Verzeichnisse des Nodes (die eigene, bei einer Brücke auch die Zieldomain) hineingereicht werden (`mount --bind`/
// `--move`): der Node kann die Flows anderer Domains weder sehen noch öffnen — der Kernel setzt das durch, nicht ein Dateirecht.
// Die Dateien bleiben dieselben (Bind-Mount): Schreiben und Lesen über die Prozessgrenze, mmap und Futex funktionieren wie sonst.
//
// Kein Root nötig (unprivilegierte User-Namespaces). Preis: der Node sieht sich als Benutzer 0 (nur im Namespace, ohne echte
// Rechte). Container-Nodes brauchen das nicht: Podman hängt ohnehin nur die eigene Domain ein (`BuildArgs`).
// Ist die Sandbox verlangt, aber nicht verfügbar, startet der Node NICHT (kein stilles Weiterlaufen ohne Abschottung).

// SandboxKey: extraEnv-Schlüssel "1" = Node in der Sandbox starten (vom Orchestrator gesetzt, wenn die Domain abgeschottet ist).
const SandboxKey = "OMP_MXL_SANDBOX"

const sandboxScript = `set -e
stage=$(mktemp -d "${TMPDIR:-/tmp}/omp-sbx.XXXXXX")
n=0
for d in $(echo "$OMP_SANDBOX_DIRS" | tr ':' ' '); do n=$((n+1)); mkdir -p "$stage/$n"; mount -n --bind "$d" "$stage/$n"; done
mount -n -t tmpfs -o mode=1777 tmpfs /dev/shm
n=0
for d in $(echo "$OMP_SANDBOX_DIRS" | tr ':' ' '); do n=$((n+1)); mkdir -p "$d"; mount -n --move "$stage/$n" "$d"; rmdir "${stage:?}/$n"; done
rmdir "${stage:?}"
exec "$@"`

var (
	sandboxOnce sync.Once
	sandboxErr  error
)

// SandboxAvailable prüft einmal, ob dieser Rechner die Sandbox bauen kann (unshare vorhanden, User-Namespaces erlaubt).
func SandboxAvailable() error {
	sandboxOnce.Do(func() {
		if _, err := exec.LookPath("unshare"); err != nil {
			sandboxErr = fmt.Errorf("unshare (util-linux) nicht gefunden")
			return
		}
		out, err := exec.Command("unshare", "--user", "--map-root-user", "--mount", "true").CombinedOutput()
		if err != nil {
			sandboxErr = fmt.Errorf("User-/Mount-Namespaces nicht erlaubt (%v: %s)", err, strings.TrimSpace(string(out)))
		}
	})
	return sandboxErr
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(env[i], key+"="); ok {
			return v
		}
	}
	return ""
}

// SandboxDirs: die Domain-Verzeichnisse, die der Node in der Sandbox sieht (eigene Domain, bei einer Brücke die Zieldomain).
func SandboxDirs(env []string) []string {
	var dirs []string
	for _, k := range []string{"OMP_MXL_DOMAIN", "OMP_MXL_TARGET_DOMAIN"} {
		if d := envValue(env, k); d != "" {
			dup := false
			for _, e := range dirs {
				dup = dup || e == d
			}
			if !dup {
				dirs = append(dirs, d)
			}
		}
	}
	return dirs
}

// WrapSandbox verpackt die Kommandozeile `argv` des Nodes, wenn `env` die Sandbox verlangt (SandboxKey=1); sonst unverändert.
// Rückgabe: neue Kommandozeile und Umgebung (mit OMP_SANDBOX_DIRS für das Hilfsskript).
func WrapSandbox(argv, env []string) ([]string, []string, error) {
	if envValue(env, SandboxKey) != "1" {
		return argv, env, nil
	}
	dirs := SandboxDirs(env)
	if len(dirs) == 0 {
		return nil, nil, fmt.Errorf("Sandbox verlangt, aber keine Domain-Verzeichnisse (OMP_MXL_DOMAIN fehlt)")
	}
	for _, d := range dirs {
		if !strings.HasPrefix(d, "/") || strings.ContainsAny(d, " \t\n:\"'$`\\") {
			return nil, nil, fmt.Errorf("Sandbox: Domainpfad %q nicht zulässig", d)
		}
	}
	if err := SandboxAvailable(); err != nil {
		return nil, nil, fmt.Errorf("Sandbox verlangt, aber nicht verfügbar: %w", err)
	}
	full := append([]string{"unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", "sh", "-c", sandboxScript, "sh"}, argv...)
	return full, append(append([]string{}, env...), "OMP_SANDBOX_DIRS="+strings.Join(dirs, ":")), nil
}

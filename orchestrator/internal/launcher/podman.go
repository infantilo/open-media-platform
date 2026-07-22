package launcher

import (
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// containerNetworkGateway ist der von rootless Podman standardmäßig
// bereitgestellte DNS-Alias, über den ein Container den Host erreicht
// (Podmans Pendant zu Docker Desktops `host.docker.internal`) — live
// geprüft (nicht angenommen), s. docs/decisions.md: ein echter
// `omp-mock`-Container erreichte darüber die Host-Registry/-NATS und
// registrierte sich erfolgreich. Bewusst **kein** `--network=host`
// (das würde die Netzwerk-Namensraum-Isolation für importierten,
// per C9-Mindestprüfung nur schwach verifizierten Fremdcode komplett
// aufheben) — Standard-Bridge-Netzwerk bleibt, nur der Weg nach außen
// (Registry/NATS) wird auf diesen Alias umgeschrieben.
const containerNetworkGateway = "host.containers.internal"

// rewriteForContainer ersetzt `localhost`/`127.0.0.1` im Host-Anteil
// einer URL durch containerNetworkGateway — die Registry-/NATS-URLs
// des Orchestrators zeigen im Dev-Betrieb auf den lokalen Host, was aus
// Container-Sicht (eigener Netzwerk-Namensraum) etwas anderes ist.
// Andere Hosts (echte Mehr-Host-Deployments, ARCHITECTURE.md §18)
// bleiben unverändert — dort ist der Registry-/NATS-Host ohnehin schon
// eine reguläre, von außen erreichbare Adresse.
func rewriteForContainer(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" {
		return rawURL
	}
	port := parsed.Port()
	if port != "" {
		parsed.Host = containerNetworkGateway + ":" + port
	} else {
		parsed.Host = containerNetworkGateway
	}
	return parsed.String()
}

// findFreePort bittet das Betriebssystem um einen aktuell freien
// TCP-Port (`:0`-Listen-Trick) und gibt ihn sofort wieder frei — anders
// als beim Prozess-Runner (dort wählt der Node-Prozess selbst per
// `OMP_PORT=0` einen Port und meldet ihn erst danach per IS-04, s.
// buildEnv-Doku) muss der Launcher den Port hier **vorher** kennen, um
// ihn per `podman run -p` zu veröffentlichen — ein Container kann nicht
// nachträglich "gefragt" werden, welchen Port sein Prozess intern
// gewählt hat. Kleines, unvermeidbares TOCTOU-Fenster zwischen dem
// Schließen hier und `podman run` unten (gleiche Kategorie Race wie in
// jedem "finde einen freien Port"-Muster ohne Betriebssystem-Reservierung
// über den eigentlichen Bind-Aufruf hinaus) — für den Einzel-Instanz-
// Startfall dieser Runde hinnehmbar.
func findFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("launcher: find free port: %w", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// runPodmanEntry startet entry als Podman-Container: fester, vorab
// belegter Port (innen wie außen identisch, s. findFreePort-Doku),
// Standard-Bridge-Netzwerk (kein `--network=host`), dieselben fünf
// Launcher-eigenen Variablen wie buildEnv (OMP_INSTANCE_ID/OMP_LABEL/
// OMP_HOST/OMP_PORT/OMP_REGISTRY_URL/OMP_NATS_URL — OMP_HOST bewusst
// `127.0.0.1` statt `0.0.0.0`: das ist die vom Node selbst für seine
// IS-04-Registrierung **advertisierte** Adresse, muss also die vom
// Orchestrator aus erreichbare sein, nicht die containerinterne
// Bind-Adresse). `--rm`: Podman entfernt den Container beim Beenden
// selbst, kein zusätzlicher Aufräumschritt nötig (gleiche Idempotenz-
// Erwartung wie bei den Infra-Containern aus `make up`).
func runPodmanEntry(entry CatalogEntry, id, label, launchSecret string, extraEnv map[string]string, registryURL, orchestratorURL, natsURL string) (containerID string, hostPort int, err error) {
	port, err := findFreePort()
	if err != nil {
		return "", 0, err
	}

	merged := map[string]string{}
	for k, v := range entry.Env {
		merged[k] = v
	}
	for k, v := range extraEnv {
		merged[k] = v
	}
	merged["OMP_INSTANCE_ID"] = id
	merged["OMP_LABEL"] = label
	merged["OMP_HOST"] = "127.0.0.1"
	merged["OMP_PORT"] = strconv.Itoa(port)
	merged["OMP_REGISTRY_URL"] = rewriteForContainer(registryURL)
	merged["OMP_NATS_URL"] = rewriteForContainer(natsURL)
	// OMP_ORCHESTRATOR_URL/OMP_LAUNCH_SECRET (ARCHITECTURE.md §24.1,
	// UMSETZUNG.md C16) — gleiches Rewrite wie Registry/NATS, der
	// Container erreicht den Orchestrator sonst nicht unter dessen
	// eigener Localhost-Adresse.
	merged["OMP_ORCHESTRATOR_URL"] = rewriteForContainer(orchestratorURL)
	if launchSecret != "" {
		merged["OMP_LAUNCH_SECRET"] = launchSecret
	}

	args := []string{
		"run", "-d", "--rm",
		"--name", "omp-" + id,
		"-p", fmt.Sprintf("%d:%d", port, port),
	}
	for k, v := range merged {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, entry.Image)
	// Command ist für den Podman-Runner optional (anders als beim
	// Prozess-Runner, wo es Pflicht ist) — ein gesetztes Command
	// überschreibt das Image-eigene Entrypoint/CMD (Podman-Konvention:
	// `podman run ... <image> [COMMAND] [ARG...]`), z. B. für generische
	// Test-/Utility-Images ohne node-contract-fähiges Entrypoint.
	args = append(args, entry.Command...)

	out, err := exec.Command("podman", args...).Output()
	if err != nil {
		return "", 0, fmt.Errorf("podman run %s: %w", entry.Image, describeExitError(err))
	}
	return strings.TrimSpace(string(out)), port, nil
}

// stopPodmanContainer beendet einen Container graceful (SIGTERM, dann
// SIGKILL nach grace, exakt Podmans eigene `stop --time`-Semantik —
// identisches Verhalten zum SIGTERM/SIGKILL-Paar des Prozess-Runners,
// nur von Podman selbst statt von Hand durchgeführt).
func stopPodmanContainer(containerID string, grace time.Duration) error {
	seconds := int(grace.Round(time.Second) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	cmd := exec.Command("podman", "stop", "--time", strconv.Itoa(seconds), containerID)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("podman stop %s: %w (%s)", containerID, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// waitPodmanContainer blockiert, bis der Container endet (natürlich
// oder durch stopPodmanContainer), und liefert seinen Exit-Code —
// Podman-Pendant zu `(*exec.Cmd).Wait()`. Ein Exit-Code von 0 gilt wie
// bei Prozessen als regulär; supervisePodman entscheidet identisch zu
// supervise (via `stillTracked`-Check), ob das Ende erwartet (Stop()
// hat die Instanz bereits entfernt) oder ein echter Absturz war.
func waitPodmanContainer(containerID string) (exitCode int, err error) {
	out, err := exec.Command("podman", "wait", containerID).Output()
	if err != nil {
		return 0, fmt.Errorf("podman wait %s: %w", containerID, describeExitError(err))
	}
	code, parseErr := strconv.Atoi(strings.TrimSpace(string(out)))
	if parseErr != nil {
		return 0, fmt.Errorf("podman wait %s: unparsable exit code %q", containerID, out)
	}
	return code, nil
}

// podmanContainerRunning prüft nach einem Orchestrator-Neustart, ob ein
// zuvor persistierter Container noch läuft — Podman-Pendant zu
// processAlive(pid) (loadState). `podman inspect` auf eine unbekannte
// ID liefert einen Fehler, was hier wie "läuft nicht mehr" behandelt
// wird (gleiche Nachsicht wie processAlive bei os.FindProcess).
func podmanContainerRunning(containerID string) bool {
	out, err := exec.Command("podman", "inspect", "--format", "{{.State.Running}}", containerID).Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "true"
}

// describeExitError reichert einen *exec.ExitError um dessen Stderr an
// (Podman schreibt Fehlermeldungen dorthin) — ohne das wäre ein
// fehlgeschlagener `podman`-Aufruf nur als nichtssagender "exit status
// 125" sichtbar.
func describeExitError(err error) error {
	if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(exitErr.Stderr)))
	}
	return err
}

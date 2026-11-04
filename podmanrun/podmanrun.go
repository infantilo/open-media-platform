// Package podmanrun startet und beendet Node-Container mit Podman. Es wird vom Orchestrator
// (lokaler Podman-Runner) UND vom Host-Agent (Kap. 85: importierte Microservices auf Remote-Hosts)
// benutzt — gemeinsamer Code statt Duplikat, damit beide Seiten Port-Wahl, Adress-Umschreibung und
// Vertrauens-Opt-ins (MxlAccess, MediaRead, HostNetwork, ExtraPort, DataDir) identisch behandeln.
// Eigenes Go-Modul (Muster wie jobwire/nodeoptions), nur Standardbibliothek.
package podmanrun

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultMxlDomain: Standard der MXL-Domain (OMP_MXL_DOMAIN), wie in deploy/dev/start-omp.sh.
const DefaultMxlDomain = "/dev/shm/omp-mxl"

// ContainerNetworkGateway ist der DNS-Alias, über den ein Container im Bridge-Netz den Host erreicht.
// Bewusst kein --network=host als Standard (Namensraum-Isolation für schwach geprüften Fremdcode).
const ContainerNetworkGateway = "host.containers.internal"

// Entry ist die für den Start nötige Teilmenge eines Katalogeintrags (runner:"podman").
type Entry struct {
	Type        string
	Image       string
	Command     []string
	Env         map[string]string
	MxlAccess   bool
	MediaRead   bool
	HostNetwork bool
	ExtraPort   bool
	DataDir     string
}

// Params sind die Laufzeitwerte eines Starts.
type Params struct {
	ID              string
	Label           string
	LaunchSecret    string
	ExtraEnv        map[string]string
	RegistryURL     string
	OrchestratorURL string
	NatsURL         string
	// AdvertiseHost: Adresse, unter der der Node sich per IS-04 ankündigt (OMP_HOST). Leer = 127.0.0.1.
	AdvertiseHost string
	// NodeAPIToken: wird als OMP_NODE_API_TOKEN gesetzt (leer = nicht gesetzt).
	NodeAPIToken string
}

// MediaMountPaths: absolute Pfade aus OMP_MEDIA_MOUNTS (durch `:` getrennt).
func MediaMountPaths() []string {
	var out []string
	for _, p := range strings.Split(os.Getenv("OMP_MEDIA_MOUNTS"), ":") {
		if p = strings.TrimSpace(p); filepath.IsAbs(p) {
			out = append(out, filepath.Clean(p))
		}
	}
	return out
}

// MxlDomainPath: lokale MXL-Domain (OMP_MXL_DOMAIN oder Standard).
func MxlDomainPath() string {
	if d := os.Getenv("OMP_MXL_DOMAIN"); d != "" {
		return d
	}
	return DefaultMxlDomain
}

// RewriteForContainer ersetzt localhost/127.0.0.1 im Host-Anteil durch ContainerNetworkGateway.
func RewriteForContainer(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" {
		return rawURL
	}
	if port := parsed.Port(); port != "" {
		parsed.Host = ContainerNetworkGateway + ":" + port
	} else {
		parsed.Host = ContainerNetworkGateway
	}
	return parsed.String()
}

// FindFreePort bittet das Betriebssystem um einen freien TCP-Port (kleines TOCTOU-Fenster bis `podman run`).
func FindFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("podmanrun: find free port: %w", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// DataVolumeName: Name des dauerhaften Datenvolumens eines Node-Typs.
func DataVolumeName(nodeType string) string { return "omp-data-" + nodeType }

// BuildArgs liefert die `podman`-Argumente und die gewählten Ports (ohne etwas zu starten — testbar).
func BuildArgs(e Entry, p Params, port, extraPort int) []string {
	merged := map[string]string{}
	for k, v := range e.Env {
		merged[k] = v
	}
	for k, v := range p.ExtraEnv {
		merged[k] = v
	}
	advertise := p.AdvertiseHost
	if advertise == "" {
		advertise = "127.0.0.1"
	}
	merged["OMP_INSTANCE_ID"] = p.ID
	merged["OMP_LABEL"] = p.Label
	merged["OMP_HOST"] = advertise
	merged["OMP_PORT"] = strconv.Itoa(port)
	rewrite := RewriteForContainer
	if e.HostNetwork {
		rewrite = func(u string) string { return u }
	} else {
		merged["OMP_LOOPBACK_ALIAS"] = ContainerNetworkGateway
	}
	merged["OMP_REGISTRY_URL"] = rewrite(p.RegistryURL)
	merged["OMP_NATS_URL"] = rewrite(p.NatsURL)
	merged["OMP_ORCHESTRATOR_URL"] = rewrite(p.OrchestratorURL)
	if p.LaunchSecret != "" {
		merged["OMP_LAUNCH_SECRET"] = p.LaunchSecret
	}
	if p.NodeAPIToken != "" {
		merged["OMP_NODE_API_TOKEN"] = p.NodeAPIToken
	}
	if e.ExtraPort {
		merged["OMP_EXTRA_PORT"] = strconv.Itoa(extraPort)
	}

	args := []string{"run", "-d", "--rm", "--name", "omp-" + p.ID}
	if e.HostNetwork {
		args = append(args, "--network=host")
	} else {
		args = append(args, "-p", fmt.Sprintf("%d:%d", port, port))
	}
	if e.DataDir != "" {
		args = append(args, "-v", DataVolumeName(e.Type)+":"+e.DataDir)
	}
	if e.ExtraPort && !e.HostNetwork {
		args = append(args, "-p", fmt.Sprintf("%d:%d", extraPort, extraPort))
	}
	if e.MxlAccess {
		domain := MxlDomainPath()
		args = append(args, "-v", domain+":"+domain)
	}
	if e.MediaRead {
		for _, d := range MediaMountPaths() {
			args = append(args, "-v", d+":"+d+":ro")
		}
	}
	// Reihenfolge der -e-Argumente stabil halten (Tests, Logs)
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		args = append(args, "-e", k+"="+merged[k])
	}
	args = append(args, e.Image)
	args = append(args, e.Command...)
	return args
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// Binary ist der aufgerufene Podman-Befehl (Variable: Tests setzen ein Fake-Skript).
var Binary = "podman"

// Run startet den Container und liefert Container-ID und den vorab gewählten Port.
func Run(e Entry, p Params) (containerID string, hostPort int, err error) {
	port, err := FindFreePort()
	if err != nil {
		return "", 0, err
	}
	var extraPort int
	if e.ExtraPort {
		if extraPort, err = FindFreePort(); err != nil {
			return "", 0, err
		}
	}
	out, err := exec.Command(Binary, BuildArgs(e, p, port, extraPort)...).Output()
	if err != nil {
		return "", 0, fmt.Errorf("podman run %s: %w", e.Image, DescribeExitError(err))
	}
	return strings.TrimSpace(string(out)), port, nil
}

// Stop beendet einen Container graceful (SIGTERM, nach grace SIGKILL).
func Stop(containerID string, grace time.Duration) error {
	seconds := int(grace.Round(time.Second) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	if out, err := exec.Command(Binary, "stop", "--time", strconv.Itoa(seconds), containerID).CombinedOutput(); err != nil {
		return fmt.Errorf("podman stop %s: %w (%s)", containerID, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Wait blockiert bis der Container endet und liefert den Exit-Code.
func Wait(containerID string) (int, error) {
	out, err := exec.Command(Binary, "wait", containerID).Output()
	if err != nil {
		return 0, fmt.Errorf("podman wait %s: %w", containerID, DescribeExitError(err))
	}
	code, perr := strconv.Atoi(strings.TrimSpace(string(out)))
	if perr != nil {
		return 0, fmt.Errorf("podman wait %s: unparsable exit code %q", containerID, out)
	}
	return code, nil
}

// Running prüft, ob der Container noch läuft.
func Running(containerID string) bool {
	out, err := exec.Command(Binary, "inspect", "--format", "{{.State.Running}}", containerID).Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// DescribeExitError hängt Podmans Stderr an einen *exec.ExitError.
func DescribeExitError(err error) error {
	if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
	}
	return err
}

// RemoveImage löscht ein Image (ohne -f; "schon weg" ist kein Fehler).
func RemoveImage(image string) error {
	out, err := exec.Command(Binary, "rmi", image).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if strings.Contains(text, "image not known") || strings.Contains(text, "no such image") {
			return nil
		}
		return fmt.Errorf("podman rmi %s: %w (%s)", image, err, text)
	}
	return nil
}

// RemoveDataVolume löscht das Datenvolumen eines Typs (fehlt es, ist das kein Fehler).
func RemoveDataVolume(nodeType string) error {
	out, err := exec.Command(Binary, "volume", "rm", DataVolumeName(nodeType)).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if strings.Contains(text, "no such volume") || strings.Contains(text, "no volume with name") {
			return nil
		}
		return fmt.Errorf("podman volume rm %s: %w (%s)", DataVolumeName(nodeType), err, text)
	}
	return nil
}

// ImageExists: `podman image exists`.
func ImageExists(image string) bool {
	return exec.Command(Binary, "image", "exists", image).Run() == nil
}

// ImageDigest liefert die ID (sha256:…) des lokal vorhandenen Images.
func ImageDigest(image string) (string, error) {
	out, err := exec.Command(Binary, "image", "inspect", "--format", "{{.Id}}", image).Output()
	if err != nil {
		return "", fmt.Errorf("podman image inspect %s: %w", image, DescribeExitError(err))
	}
	id := strings.TrimSpace(string(out))
	if !strings.HasPrefix(id, "sha256:") {
		id = "sha256:" + id
	}
	return id, nil
}

// PID liefert die Host-PID des Container-Hauptprozesses (0 wenn unbekannt) — für die CPU-/RAM-Telemetrie.
func PID(containerID string) int {
	out, err := exec.Command(Binary, "inspect", "--format", "{{.State.Pid}}", containerID).Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

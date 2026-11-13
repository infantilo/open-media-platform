package launcher

import (
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
	"github.com/infantilo/openmediaplatform/podmanrun"
)

// Die Podman-Kommandos (Start-Argumente, Port-Wahl, Adress-Umschreibung, Stop/Wait/Inspect) liegen seit Kap. 85 im
// gemeinsamen Modul podmanrun, damit der Host-Agent denselben Code nutzt. Die Namen unten bleiben als dünne Hüllen,
// weil Launcher und Tests sie so aufrufen.

const containerNetworkGateway = podmanrun.ContainerNetworkGateway

func rewriteForContainer(rawURL string) string { return podmanrun.RewriteForContainer(rawURL) }

func findFreePort() (int, error) { return podmanrun.FindFreePort() }

func mediaMountPaths() []string { return podmanrun.MediaMountPaths() }

func mxlDomainPath() string { return podmanrun.MxlDomainPath() }

func podmanEntryOf(e CatalogEntry) podmanrun.Entry {
	return podmanrun.Entry{Type: e.Type, Image: e.Image, Command: e.Command, Env: e.Env, MxlAccess: e.MxlAccess,
		MediaRead: e.MediaRead, HostNetwork: e.HostNetwork, ExtraPort: e.ExtraPort, DataDir: e.DataDir}
}

// runPodmanEntry startet entry als Podman-Container (Details: podmanrun.Run). OMP_HOST ist 127.0.0.1: der Orchestrator
// startet lokal, die advertisierte Adresse muss vom Orchestrator aus erreichbar sein.
func runPodmanEntry(entry CatalogEntry, id, label, launchSecret string, extraEnv map[string]string, registryURL, orchestratorURL, natsURL string) (containerID string, hostPort int, err error) {
	containerID, hostPort, err = podmanrun.Run(podmanEntryOf(entry), podmanrun.Params{ID: id, Label: label, LaunchSecret: launchSecret,
		ExtraEnv: extraEnv, RegistryURL: registryURL, OrchestratorURL: orchestratorURL, NatsURL: natsURL})
	if err != nil {
		return "", 0, fmt.Errorf("%s %w", errcodes.Prefix("OMP-2002"), err)
	}
	return containerID, hostPort, nil
}

func stopPodmanContainer(containerID string, grace time.Duration) error {
	return podmanrun.Stop(containerID, grace)
}

func waitPodmanContainer(containerID string) (exitCode int, err error) {
	return podmanrun.Wait(containerID)
}

func podmanContainerRunning(containerID string) bool { return podmanrun.Running(containerID) }

func describeExitError(err error) error { return podmanrun.DescribeExitError(err) }

// removeContainerImage löscht ein Container-Image vom Host. Variable, damit Tests ohne Podman auskommen.
var removeContainerImage = podmanrun.RemoveImage

func dataVolumeName(nodeType string) string { return podmanrun.DataVolumeName(nodeType) }

// removeDataVolume löscht das Datenvolumen eines Node-Typs. Variable für Tests.
var removeDataVolume = podmanrun.RemoveDataVolume

func killPodmanContainer(containerID string) error { return podmanrun.Kill(containerID) }

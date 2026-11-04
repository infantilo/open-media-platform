package commands

// Container-Runner des Host-Agent (Kap. 85): Start/Stop eines importierten Microservice (runner:"podman").
// Start-Argumente, Port-Wahl und Adress-Umschreibung kommen aus dem gemeinsamen Modul podmanrun — derselbe Code
// wie im Orchestrator. Der Agent entscheidet selbst, welche Vertrauens-Opt-ins er erlaubt (microsvc-Allowlist
// wird schon bei der Installation angewandt, s. microsvc.go); hier laufen nur bereits geprüfte Einträge.

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/podmanrun"
)

// findEntry sucht zuerst im statischen Katalog, dann unter den installierten Microservices
// (mit Version, sonst die zuletzt installierte).
func (e *Executor) findEntry(nodeType, version string) (catalog.Entry, bool) {
	if version == "" {
		if entry, ok := catalog.Find(e.catalog, nodeType); ok {
			return entry, true
		}
	}
	if e.installed != nil {
		return e.installed.Find(nodeType, version)
	}
	return catalog.Entry{}, false
}

func podmanEntry(en catalog.Entry) podmanrun.Entry {
	return podmanrun.Entry{Type: en.Type, Image: en.Image, Command: en.Command, Env: en.Env, MxlAccess: en.MxlAccess,
		MediaRead: en.MediaRead, HostNetwork: en.HostNetwork, ExtraPort: en.ExtraPort, DataDir: en.DataDir}
}

func (e *Executor) startPodman(req Request, entry catalog.Entry, extra map[string]string, ignored []string) Response {
	label := req.Label
	if label == "" {
		label = entry.Type
	}
	containerID, _, err := podmanrun.Run(podmanEntry(entry), podmanrun.Params{
		ID: req.InstanceID, Label: label, LaunchSecret: req.LaunchSecret, ExtraEnv: extra,
		RegistryURL: e.registryURL, OrchestratorURL: e.orchestratorURL, NatsURL: e.natsURL,
		AdvertiseHost: os.Getenv("OMP_HOST"), NodeAPIToken: req.NodeAPIToken,
	})
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("start: %v", err)}
	}

	e.mu.Lock()
	e.instances[req.InstanceID] = &runningInstance{containerID: containerID, nodeType: entry.Type, version: entry.Version, stderrTail: newTailBuffer(crashStderrLines)}
	e.mu.Unlock()

	go func() {
		code, werr := podmanrun.Wait(containerID)
		e.mu.Lock()
		expected := e.stopping[req.InstanceID]
		delete(e.instances, req.InstanceID)
		delete(e.stopping, req.InstanceID)
		e.mu.Unlock()
		if expected {
			slog.Info("host-agent: container instance stopped", "instance_id", req.InstanceID, "type", req.Type)
			return
		}
		slog.Warn("host-agent: container exited unexpectedly", "instance_id", req.InstanceID, "type", req.Type, "error", werr, "exit_code", code)
		tail := ""
		if werr != nil {
			tail = werr.Error()
		}
		if code != 0 {
			tail = fmt.Sprintf("container exit code %d %s", code, tail)
		}
		e.publishExit(req.InstanceID, code, strings.TrimSpace(tail))
	}()

	detail := ""
	if len(ignored) > 0 {
		detail = "ignored options (not declared in this host's node-options.json): " + strings.Join(ignored, ", ")
	}
	return Response{OK: true, PID: podmanrun.PID(containerID), Detail: detail}
}

func (e *Executor) stopPodman(instanceID string, ri *runningInstance) Response {
	if err := podmanrun.Stop(ri.containerID, stopGracePeriod); err != nil {
		if !podmanrun.Running(ri.containerID) {
			return Response{OK: true} // schon beendet
		}
		return Response{OK: false, Error: err.Error()}
	}
	deadline := time.Now().Add(stopGracePeriod + 2*time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		_, still := e.instances[instanceID]
		e.mu.Unlock()
		if !still {
			return Response{OK: true}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return Response{OK: true}
}

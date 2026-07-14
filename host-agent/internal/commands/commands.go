// Package commands verarbeitet Start-/Stop-Kommandos, die der
// Orchestrator über NATS Request/Reply schickt (ARCHITECTURE.md §18.5,
// UMSETZUNG.md D6 Teil 2: "Instanz-Launcher wird Remote-fähig") — das
// Host-Agent-Gegenstück zu orchestrator/internal/launcher, aber ohne
// dessen Crash-Erkennung/Persistenz (dokumentierte Folgearbeit, s.
// docs/decisions.md D6 Teil 2): dieser erste Schritt macht entfernte
// Hosts nur als Startziel *nutzbar*, verhält sich bei einem Absturz der
// gestarteten Instanz aber noch wie "stillschweigend beendet" statt wie
// die rot markierte Crash-Anzeige, die der lokale Launcher seit C13-
// Nachtrag-3 bietet.
package commands

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

// stopGracePeriod ist die Wartezeit zwischen SIGTERM und SIGKILL —
// gleicher Wert wie orchestrator/internal/launcher.
const stopGracePeriod = 3 * time.Second

// Request ist die auf omp.host.<hostId>.cmd empfangene Nachricht.
type Request struct {
	Action     string `json:"action"` // "start" | "stop"
	Type       string `json:"type,omitempty"`
	InstanceID string `json:"instanceId"`
	Label      string `json:"label,omitempty"`
}

// Response ist die Antwort auf Request.
type Response struct {
	OK    bool   `json:"ok"`
	PID   int    `json:"pid,omitempty"`
	Error string `json:"error,omitempty"`
}

// Executor führt Start-/Stop-Kommandos für die auf diesem Host lokal
// laufenden Instanzen aus.
type Executor struct {
	catalog     []catalog.Entry
	registryURL string
	natsURL     string

	mu        sync.Mutex
	instances map[string]*exec.Cmd
}

// NewExecutor erstellt einen Executor. registryURL/natsURL werden an
// jede gestartete Instanz weitergereicht (dieselben Werte, mit denen
// sich der Host-Agent selbst am Facility-Bus orientiert — auf der
// Single-Host-Dev-Maschine identisch zu den Orchestrator-eigenen
// URLs, auf echten Mehr-Host-Setups Betreiberverantwortung, s.
// docs/decisions.md D6 Teil 2).
func NewExecutor(cat []catalog.Entry, registryURL, natsURL string) *Executor {
	return &Executor{
		catalog:     cat,
		registryURL: registryURL,
		natsURL:     natsURL,
		instances:   map[string]*exec.Cmd{},
	}
}

// Handle verarbeitet eine eingehende Anfrage und liefert die Antwort.
func (e *Executor) Handle(req Request) Response {
	switch req.Action {
	case "start":
		return e.start(req)
	case "stop":
		return e.stop(req)
	default:
		return Response{OK: false, Error: fmt.Sprintf("unknown action %q", req.Action)}
	}
}

func (e *Executor) start(req Request) Response {
	entry, ok := catalog.Find(e.catalog, req.Type)
	if !ok {
		return Response{OK: false, Error: fmt.Sprintf("unknown catalog type %q on this host", req.Type)}
	}
	if entry.Runner != catalog.RunnerProcess {
		return Response{OK: false, Error: fmt.Sprintf("unsupported runner %q", entry.Runner)}
	}
	if req.InstanceID == "" {
		return Response{OK: false, Error: "instanceId required"}
	}

	cmd := exec.Command(entry.Command[0], entry.Command[1:]...)
	cmd.Env = buildEnv(entry.Env, req.InstanceID, req.Label, e.registryURL, e.natsURL)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("start: %v", err)}
	}

	e.mu.Lock()
	e.instances[req.InstanceID] = cmd
	e.mu.Unlock()

	pid := cmd.Process.Pid
	go func() {
		// Reapt den Kindprozess (verhindert Zombies) — anders als der
		// Orchestrator-Launcher (der einen Crash aktiv als Event
		// meldet) wird das Ergebnis hier nur geloggt, nicht an den
		// Orchestrator zurückgemeldet (dokumentierte Folgearbeit, s.
		// Paketkommentar).
		waitErr := cmd.Wait()
		e.mu.Lock()
		delete(e.instances, req.InstanceID)
		e.mu.Unlock()
		if waitErr != nil {
			slog.Warn("host-agent: instance exited", "instance_id", req.InstanceID, "type", req.Type, "error", waitErr)
		}
	}()

	return Response{OK: true, PID: pid}
}

func (e *Executor) stop(req Request) Response {
	e.mu.Lock()
	cmd, ok := e.instances[req.InstanceID]
	e.mu.Unlock()
	if !ok {
		// Idempotent wie der Orchestrator-Launcher: eine bereits
		// beendete/unbekannte Instanz ist kein Fehler.
		return Response{OK: true}
	}

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		return Response{OK: true} // wahrscheinlich schon beendet
	}

	deadline := time.Now().Add(stopGracePeriod)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		_, stillRunning := e.instances[req.InstanceID]
		e.mu.Unlock()
		if !stillRunning {
			return Response{OK: true}
		}
		time.Sleep(100 * time.Millisecond)
	}

	e.mu.Lock()
	_, stillRunning := e.instances[req.InstanceID]
	e.mu.Unlock()
	if stillRunning {
		_ = cmd.Process.Kill()
	}
	return Response{OK: true}
}

// DecodeRequest/EncodeResponse kapseln das Wire-Format (JSON über den
// NATS-Request/Reply-Payload) — eigene Funktionen statt Inline-
// json.Marshal an jeder Aufrufstelle, damit main.go den Fehlerfall
// (kaputtes JSON) einheitlich behandelt.
func DecodeRequest(payload []byte) (Request, error) {
	var req Request
	err := json.Unmarshal(payload, &req)
	return req, err
}

func EncodeResponse(resp Response) []byte {
	data, _ := json.Marshal(resp)
	return data
}

// buildEnv — identische Logik zu orchestrator/internal/launcher.buildEnv
// (bewusste kleine Duplikation, s. Paketkommentar oben).
func buildEnv(entryEnv map[string]string, instanceID, label, registryURL, natsURL string) []string {
	merged := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				merged[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	for k, v := range entryEnv {
		merged[k] = v
	}
	merged["OMP_INSTANCE_ID"] = instanceID
	merged["OMP_LABEL"] = label
	merged["OMP_PORT"] = "0"
	merged["OMP_REGISTRY_URL"] = registryURL
	merged["OMP_NATS_URL"] = natsURL

	env := make([]string, 0, len(merged))
	for k, v := range merged {
		env = append(env, k+"="+v)
	}
	return env
}

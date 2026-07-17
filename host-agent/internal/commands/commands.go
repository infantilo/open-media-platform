// Package commands verarbeitet Start-/Stop-Kommandos, die der
// Orchestrator über NATS Request/Reply schickt (ARCHITECTURE.md §18.5,
// UMSETZUNG.md D6 Teil 2: "Instanz-Launcher wird Remote-fähig") — das
// Host-Agent-Gegenstück zu orchestrator/internal/launcher.
//
// Seit S3 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) meldet der
// Executor ein unerwartetes Prozessende zusätzlich als NATS-Event
// (omp.host.<hostId>.events) an den Orchestrator zurück — das
// Gegenstück zu orchestrator/internal/launcher.supervise()'s lokalem
// cmd.Wait()-Ende. Die eigentliche Crash-Loop-Bremse/Neustart-
// Entscheidung bleibt beim Orchestrator (Launcher.HandleRemoteExit):
// der Host-Agent meldet nur den Fakt "Instanz X mit Exit-Code Y
// beendet", trifft selbst keine Wiederanlauf-Entscheidung — dieselbe
// Verantwortungsteilung wie beim Start-Kommando (Agent führt aus, der
// Orchestrator entscheidet).
package commands

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
)

// Publisher ist die von Executor für ExitEvent-Publishing (S3) genutzte
// Teilmenge von *nats.Conn — als Interface gehalten, damit Tests einen
// Fake statt einer echten NATS-Verbindung einsetzen können (gleiches
// Muster wie orchestrator/internal/launcher.NATSRequester).
type Publisher interface {
	Publish(subject string, data []byte) error
}

// stopGracePeriod ist die Wartezeit zwischen SIGTERM und SIGKILL —
// gleicher Wert wie orchestrator/internal/launcher.
const stopGracePeriod = 3 * time.Second

// crashStderrLines — gleicher Wert/Zweck wie
// orchestrator/internal/launcher.crashStderrLines.
const crashStderrLines = 5

// allowedExtraEnvKeys ist die Allowlist für Request.ExtraEnv (S3) —
// **nicht** frei durchgereicht, sonst könnte ein kompromittierter/
// fehlerhafter Orchestrator beliebige Umgebungsvariablen in einen
// Subprozess auf diesem Host einschleusen. Das widerspräche der
// dokumentierten Sicherheitsgrenze (Paketkommentar oben: "der
// Agent-lokale Katalog entscheidet, was läuft", nicht der
// Orchestrator) — die Allowlist ist die gleiche Grenze, nur für
// Umgebungsvariablen statt für den Node-Typ. Zunächst nur die beiden
// Kapitel-15-Werte (Workflow-Auflösung); Erweiterung ist additiv, kein
// Format-Wechsel.
var allowedExtraEnvKeys = map[string]bool{
	"OMP_WIDTH":  true,
	"OMP_HEIGHT": true,
}

// Request ist die auf omp.host.<hostId>.cmd empfangene Nachricht.
type Request struct {
	Action     string `json:"action"` // "start" | "stop"
	Type       string `json:"type,omitempty"`
	InstanceID string `json:"instanceId"`
	Label      string `json:"label,omitempty"`
	// ExtraEnv überschreibt den Katalog-eigenen env-Block für passende
	// Schlüssel (S3, gleiches Feld/Zweck wie
	// orchestrator/internal/launcher.Start — Kapitel-15-Workflow-
	// Settings wie die Programm-Auflösung). Jeder Schlüssel muss in
	// allowedExtraEnvKeys stehen, sonst lehnt start() die gesamte
	// Anfrage ab (s. Feld-Kommentar dort).
	ExtraEnv map[string]string `json:"extraEnv,omitempty"`
}

// Response ist die Antwort auf Request.
type Response struct {
	OK    bool   `json:"ok"`
	PID   int    `json:"pid,omitempty"`
	Error string `json:"error,omitempty"`
}

// ExitEvent ist die auf omp.host.<hostId>.events veröffentlichte
// Nachricht (S3) — orchestrator/internal/launcher dupliziert diese
// Struktur als remoteExitEvent (gleiches Muster wie
// remoteCommand/remoteResponse für das Kommando-Wire-Format, s. dortiger
// Kommentar: eigenständige Go-Module, kein gemeinsames drittes Paket
// für ein derart schmales Format).
type ExitEvent struct {
	InstanceID string `json:"instanceId"`
	// ExitCode ist -1, wenn der Prozess durch ein Signal beendet wurde
	// (Go-Konvention, os.ProcessState.ExitCode()).
	ExitCode   int    `json:"exitCode"`
	StderrTail string `json:"stderrTail,omitempty"`
}

// runningInstance bündelt den laufenden Subprozess mit seinem
// stderr-Tail-Puffer (für ExitEvent.StderrTail bei einem unerwarteten
// Ende, gleicher Zweck wie orchestrator/internal/launcher.tailBuffer).
type runningInstance struct {
	cmd        *exec.Cmd
	stderrTail *tailBuffer
}

// Executor führt Start-/Stop-Kommandos für die auf diesem Host lokal
// laufenden Instanzen aus.
type Executor struct {
	catalog     []catalog.Entry
	registryURL string
	natsURL     string
	hostID      string
	nc          Publisher

	mu        sync.Mutex
	instances map[string]*runningInstance
	// stopping merkt sich Instanz-IDs, für die stop() bereits SIGTERM/
	// SIGKILL geschickt hat (S3) — die Wait()-Goroutine in start()
	// braucht dieses Signal, um ein erwartetes Prozessende (kein
	// ExitEvent) von einem echten Absturz (ExitEvent + Crash-Loop-
	// Bremse beim Orchestrator) zu unterscheiden. Gleiche Grundidee wie
	// orchestrator/internal/launcher.supervise()'s "noch in l.instances
	// getrackt?"-Prüfung, hier als eigene Map statt als Nebenwirkung
	// der Lösch-Reihenfolge, weil instances hier weiterhin bis zum
	// tatsächlichen Prozessende gebraucht wird (Stop-Polling-Schleife
	// unten prüft "noch drin?").
	stopping map[string]bool
}

// NewExecutor erstellt einen Executor. registryURL/natsURL werden an
// jede gestartete Instanz weitergereicht (dieselben Werte, mit denen
// sich der Host-Agent selbst am Facility-Bus orientiert — auf der
// Single-Host-Dev-Maschine identisch zu den Orchestrator-eigenen
// URLs, auf echten Mehr-Host-Setups Betreiberverantwortung, s.
// docs/decisions.md D6 Teil 2). hostID/nc (S3) werden für
// ExitEvent-Publishing gebraucht — nc darf nil sein (z. B. in Tests),
// dann bleibt publishExit ein No-Op statt eine Nil-Pointer-Panik.
func NewExecutor(cat []catalog.Entry, registryURL, natsURL, hostID string, nc Publisher) *Executor {
	return &Executor{
		catalog:     cat,
		registryURL: registryURL,
		natsURL:     natsURL,
		hostID:      hostID,
		nc:          nc,
		instances:   map[string]*runningInstance{},
		stopping:    map[string]bool{},
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
	for k := range req.ExtraEnv {
		if !allowedExtraEnvKeys[k] {
			return Response{OK: false, Error: fmt.Sprintf("extraEnv key %q not allowed", k)}
		}
	}

	stderrTail := newTailBuffer(crashStderrLines)
	cmd := exec.Command(entry.Command[0], entry.Command[1:]...)
	cmd.Env = buildEnv(entry.Env, req.ExtraEnv, req.InstanceID, req.Label, e.registryURL, e.natsURL)
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, stderrTail)

	if err := cmd.Start(); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("start: %v", err)}
	}

	e.mu.Lock()
	e.instances[req.InstanceID] = &runningInstance{cmd: cmd, stderrTail: stderrTail}
	e.mu.Unlock()

	pid := cmd.Process.Pid
	go func() {
		// Reapt den Kindprozess (verhindert Zombies). S3: anders als
		// vorher wird ein unerwartetes Ende jetzt aktiv als ExitEvent an
		// den Orchestrator zurückgemeldet (publishExit) — ein per
		// stop() erwartetes Ende (e.stopping) bleibt weiterhin ein
		// reines Log, kein Event (der Orchestrator weiß in dem Fall
		// bereits, dass die Instanz weg ist, er hat den Stop ja selbst
		// ausgelöst).
		waitErr := cmd.Wait()
		e.mu.Lock()
		expected := e.stopping[req.InstanceID]
		delete(e.instances, req.InstanceID)
		delete(e.stopping, req.InstanceID)
		e.mu.Unlock()

		if expected {
			slog.Info("host-agent: instance stopped", "instance_id", req.InstanceID, "type", req.Type)
			return
		}

		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		slog.Warn("host-agent: instance exited unexpectedly", "instance_id", req.InstanceID, "type", req.Type, "error", waitErr, "exit_code", exitCode)
		e.publishExit(req.InstanceID, exitCode, stderrTail.String())
	}()

	return Response{OK: true, PID: pid}
}

// publishExit meldet ein unerwartetes Prozessende auf
// omp.host.<hostId>.events (S3) — Best-effort wie der übrige NATS-
// Einsatz im Stack: ein Publish-Fehler wird geloggt, blockiert aber
// nicht die Reaper-Goroutine (der Prozess ist ohnehin schon beendet,
// es gibt hier nichts mehr "abzubrechen"). nc == nil (z. B. in Tests)
// macht dies zu einem No-Op statt einer Nil-Pointer-Panik.
func (e *Executor) publishExit(instanceID string, exitCode int, stderrTail string) {
	if e.nc == nil {
		return
	}
	payload, err := json.Marshal(ExitEvent{InstanceID: instanceID, ExitCode: exitCode, StderrTail: stderrTail})
	if err != nil {
		slog.Warn("host-agent: exit event marshal failed", "instance_id", instanceID, "error", err)
		return
	}
	subject := fmt.Sprintf("omp.host.%s.events", e.hostID)
	if err := e.nc.Publish(subject, payload); err != nil {
		slog.Warn("host-agent: exit event publish failed", "instance_id", instanceID, "error", err)
	}
}

func (e *Executor) stop(req Request) Response {
	e.mu.Lock()
	running, ok := e.instances[req.InstanceID]
	if ok {
		e.stopping[req.InstanceID] = true
	}
	e.mu.Unlock()
	if !ok {
		// Idempotent wie der Orchestrator-Launcher: eine bereits
		// beendete/unbekannte Instanz ist kein Fehler.
		return Response{OK: true}
	}
	cmd := running.cmd

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
// (bewusste kleine Duplikation, s. Paketkommentar oben). extraEnv (S3)
// ist bereits gegen allowedExtraEnvKeys geprüft, bevor start() hierher
// aufruft — buildEnv selbst kennt die Allowlist nicht, reine
// Merge-Funktion.
func buildEnv(entryEnv, extraEnv map[string]string, instanceID, label, registryURL, natsURL string) []string {
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
	for k, v := range extraEnv {
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

// tailBuffer — identische Logik zu
// orchestrator/internal/launcher.tailBuffer (bewusste kleine
// Duplikation, s. Paketkommentar oben).
type tailBuffer struct {
	mu       sync.Mutex
	maxLines int
	lines    []string
	partial  strings.Builder
}

func newTailBuffer(maxLines int) *tailBuffer {
	return &tailBuffer{maxLines: maxLines}
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range p {
		if c == '\n' {
			b.appendLine(b.partial.String())
			b.partial.Reset()
			continue
		}
		b.partial.WriteByte(c)
	}
	return len(p), nil
}

func (b *tailBuffer) appendLine(line string) {
	b.lines = append(b.lines, line)
	if len(b.lines) > b.maxLines {
		b.lines = b.lines[len(b.lines)-b.maxLines:]
	}
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := b.lines
	if b.partial.Len() > 0 {
		lines = append(append([]string{}, lines...), b.partial.String())
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

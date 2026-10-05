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
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/nodeoptions"
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
	"OMP_WIDTH":       true,
	"OMP_HEIGHT":      true,
	"OMP_WORKFLOW_ID": true, // 2026-09-30: Workflow-Zugehörigkeit als NMOS-Node-Tag, s. workflows/state.go workflowIDEnvKey
	"OMP_ROLE_SEED":   true, // Bug 2026-08-10: stabile node_id/device_id über einen Workflow-Neustart hinweg, s. workflows/state.go withRoleSeed
	// D13-Fix (2026-08-20): Role.RequiredIOPort (workflows/ioports.go
	// ioPortExtraEnv) reicht den geclaimten physischen Port an die
	// Instanz weiter — auf einem lokal (Orchestrator-Prozess selbst)
	// gestarteten Node griff das bereits, auf einem per Host-Agent
	// entfernt gestarteten Node (der eigentliche Zielfall für I/O-Karten,
	// die typischerweise NICHT auf der Orchestrator-Maschine stecken)
	// lehnte diese Allowlist die Anfrage bislang komplett ab
	// ("extraEnv key ... not allowed") — live mit einem echten Host-Agent
	// gefunden, s. docs/decisions.md.
	"OMP_DECKLINK_DEVICE_NUMBER": true,
	"OMP_DECKLINK_DIRECTION":     true,
	// Die Programm-/Rollenformate setzen zusätzlich zur Auflösung die Bildrate (workflows/formats.go
	// formatExtraEnv): ohne diese beiden Schlüssel lehnte der Agent jeden Remote-Start eines Workflows
	// mit Format ab ("extraEnv key OMP_FRAMERATE_DEN not allowed"). OMP_ME_LEVELS: Role.MixerLevels.
	"OMP_FRAMERATE_NUM": true,
	"OMP_FRAMERATE_DEN": true,
	"OMP_ME_LEVELS":     true,
	// Ziele der Playout-Automation, aus den Rollen des Workflows vorbelegt (workflows/autotargets.go).
	"OMP_PLAYOUT_TARGET_PLAYER_A_LABEL":    true,
	"OMP_PLAYOUT_TARGET_PLAYER_B_LABEL":    true,
	"OMP_PLAYOUT_TARGET_MIXER_LABEL":       true,
	"OMP_PLAYOUT_TARGET_AUDIO_MIXER_LABEL": true,
	"OMP_PLAYOUT_TARGET_GRAPHICS_LABEL":    true,
}

// Request ist die auf omp.host.<hostId>.cmd empfangene Nachricht.
type Request struct {
	Action     string `json:"action"` // "start" | "stop" | "update"
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
	// LaunchSecret (ARCHITECTURE.md §24.1) — Live-Fund 2026-09-11 beim
	// Verifizieren von Kapitel 6 Teil 7: bis hierhin bekam eine remote-
	// host-gestartete Instanz weder dieses Secret noch
	// OMP_ORCHESTRATOR_URL mit (dokumentierte Lücke, s. orchestrator/
	// internal/launcher.Instance.LaunchSecret-Doku, "Remote-Host-Agent-
	// Pfad bekommt das noch nicht mit") — jeder Fernaufruf eines
	// gestarteten Control-Plane-Nodes (z. B. omp-playout-automation)
	// schlug dadurch mit "kein Service-Token verfügbar" fehl, sobald er
	// nicht auf dem Orchestrator-eigenen Host lief. Leer = Katalog-
	// Einträge, die kein Service-Token brauchen (fast alle) — harmlos,
	// kein Node liest eine ungenutzte Env-Variable.
	LaunchSecret string `json:"launchSecret,omitempty"`
	// System-Update (Action "update", s. update.go): Pfad (relativ zum
	// eigenen Orchestrator, inkl. Einmal-Token), erwartete Version und
	// SHA-256 des Pakets.
	// Options (Kapitel 29): vom Orchestrator gewünschte Node-Optionen (Umgebungsvariablen).
	// Anders als ExtraEnv KEINE feste Allowlist, sondern das agent-LOKALE Schema
	// (node-options.json neben dem Katalog): nur dort für diesen Typ deklarierte Schlüssel
	// werden übernommen, jeder Wert wird auf DIESEM Host geprüft (Pfade gegen sein
	// Dateisystem). Unbekannte Schlüssel werden ignoriert und gemeldet (Response.Detail),
	// ein ungültiger Wert eines deklarierten Schlüssels lässt den Start scheitern.
	Options map[string]string `json:"options,omitempty"`
	// Path/Kind: Action "check-path" — Pfadprüfung auf diesem Host (Antwort: Detail = JSON).
	Path          string `json:"path,omitempty"`
	Kind          string `json:"kind,omitempty"`
	UpdatePath    string `json:"updatePath,omitempty"`
	UpdateVersion string `json:"updateVersion,omitempty"`
	UpdateSHA256  string `json:"updateSha256,omitempty"`
}

// Response ist die Antwort auf Request.
type Response struct {
	OK    bool   `json:"ok"`
	PID   int    `json:"pid,omitempty"`
	Error string `json:"error,omitempty"`
	// Detail: Zusatzinformation bei Erfolg (z. B. Update-Ergebnis).
	Detail string `json:"detail,omitempty"`
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
	binPath    string // Katalog-Command[0], für die "veraltet"-Erkennung
}

// Executor führt Start-/Stop-Kommandos für die auf diesem Host lokal
// laufenden Instanzen aus.
type Executor struct {
	catalog         []catalog.Entry
	registryURL     string
	natsURL         string
	orchestratorURL string
	hostID          string
	nc              Publisher
	upd             *UpdateConfig
	// nodeOptions: agent-lokales Optionsschema je Node-Typ (Kapitel 29), nil = keine Optionen.
	nodeOptions map[string][]nodeoptions.Option

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
func NewExecutor(cat []catalog.Entry, registryURL, natsURL, orchestratorURL, hostID string, nc Publisher) *Executor {
	return &Executor{
		catalog:         cat,
		registryURL:     registryURL,
		natsURL:         natsURL,
		orchestratorURL: orchestratorURL,
		hostID:          hostID,
		nc:              nc,
		instances:       map[string]*runningInstance{},
		stopping:        map[string]bool{},
	}
}

// SetNodeOptions setzt das agent-lokale Optionsschema (Kapitel 29).
func (e *Executor) SetNodeOptions(schema map[string][]nodeoptions.Option) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.nodeOptions = schema
}

// applyOptions prüft die gewünschten Optionen gegen das lokale Schema und liefert die
// zu setzenden Variablen sowie die ignorierten Schlüssel.
func (e *Executor) applyOptions(nodeType string, want map[string]string) (valid map[string]string, ignored []string, err error) {
	e.mu.Lock()
	schema := e.nodeOptions[nodeType]
	e.mu.Unlock()
	valid = map[string]string{}
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		opt, ok := nodeoptions.Find(schema, k)
		if !ok {
			ignored = append(ignored, k)
			continue
		}
		v, _, verr := nodeoptions.Validate(opt, want[k])
		if verr != nil {
			return nil, nil, fmt.Errorf("%s: %w", k, verr)
		}
		if v != "" {
			valid[k] = v
		}
	}
	return valid, ignored, nil
}

// InstanceInfo ist eine minimale Momentaufnahme einer laufenden
// Instanz (nur ID+PID) — für die Pro-Instanz-Telemetrie in main.go
// (Kapitel 14 Teil 2, docs/END-GOAL-FEATURES.md §14.3b), kein
// vollständiger State-Export.
type InstanceInfo struct {
	InstanceID string
	PID        int
	// Outdated: das Binary wurde seit dem Prozessstart ersetzt (Update).
	Outdated bool
}

// Instances liefert eine Momentaufnahme aller aktuell laufenden
// Instanzen (nur ID+PID).
func (e *Executor) Instances() []InstanceInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]InstanceInfo, 0, len(e.instances))
	for id, ri := range e.instances {
		pid := ri.cmd.Process.Pid
		out = append(out, InstanceInfo{InstanceID: id, PID: pid, Outdated: binaryNewerThanProcess(ri.binPath, pid)})
	}
	return out
}

// Handle verarbeitet eine eingehende Anfrage und liefert die Antwort.
func (e *Executor) Handle(req Request) Response {
	switch req.Action {
	case "start":
		return e.start(req)
	case "stop":
		return e.stop(req)
	case "update":
		return e.update(req)
	case "check-path":
		if req.Path == "" {
			return Response{OK: false, Error: "path required"}
		}
		data, _ := json.Marshal(nodeoptions.CheckPath(req.Path, req.Kind))
		return Response{OK: true, Detail: string(data)}
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

	opts, ignored, oerr := e.applyOptions(req.Type, req.Options)
	if oerr != nil {
		return Response{OK: false, Error: fmt.Sprintf("option rejected on this host: %v", oerr)}
	}
	extra := map[string]string{}
	for k, v := range req.ExtraEnv {
		extra[k] = v
	}
	for k, v := range opts {
		extra[k] = v
	}

	stderrTail := newTailBuffer(crashStderrLines)
	cmd := exec.Command(entry.Command[0], entry.Command[1:]...)
	cmd.Env = buildEnv(entry.Env, extra, req.InstanceID, req.Label, e.registryURL, e.natsURL, e.orchestratorURL, req.LaunchSecret)
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, stderrTail)

	if err := cmd.Start(); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("start: %v", err)}
	}

	e.mu.Lock()
	e.instances[req.InstanceID] = &runningInstance{cmd: cmd, stderrTail: stderrTail, binPath: entry.Command[0]}
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

	detail := ""
	if len(ignored) > 0 {
		detail = "ignored options (not declared in this host's node-options.json): " + strings.Join(ignored, ", ")
	}
	return Response{OK: true, PID: pid, Detail: detail}
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
func buildEnv(entryEnv, extraEnv map[string]string, instanceID, label, registryURL, natsURL, orchestratorURL, launchSecret string) []string {
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
	// OMP_ORCHESTRATOR_URL/OMP_LAUNCH_SECRET (ARCHITECTURE.md §24.1) —
	// Live-Fund 2026-09-11 (Kapitel 6 Teil 7): fehlten hier bisher
	// komplett, s. Request.LaunchSecret-Doku. Gleiche Konvention wie
	// orchestrator/internal/launcher.buildEnv: URL immer gesetzt
	// (harmlos ungenutzt für Nodes ohne Peer-Fernsteuerung), Secret nur
	// bei tatsächlichem Bedarf (leer = weiterhin kein
	// OMP_LAUNCH_SECRET im Kind-Prozess-Environment).
	merged["OMP_ORCHESTRATOR_URL"] = orchestratorURL
	if launchSecret != "" {
		merged["OMP_LAUNCH_SECRET"] = launchSecret
	}

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

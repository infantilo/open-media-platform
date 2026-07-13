// Package launcher startet/stoppt lokale Node-Instanzen aus einem festen
// Katalog heraus (UMSETZUNG.md C8, ARCHITECTURE.md §6.2 "Stufe 0" des
// später geplanten vollen Workflow-Bereitstellungs-Konzepts): bewusst
// nur "starte ein bekanntes, vorgebautes Binary als Subprozess, mehrfach
// instanziierbar auf einem Host" — kein Rollen-Template, keine
// Platzierung, kein Bundle-Start.
package launcher

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// crashStderrLines ist die Anzahl der zuletzt geschriebenen stderr-Zeilen
// einer Instanz, die bei einem unerwarteten Prozessende in
// Instance.CrashMessage aufgenommen werden (UI-Nutzerfund: "crash müssen
// angezeigt werden" — ohne Kontext aus der Ausgabe selbst wäre der Toast/
// die Kachel-Markierung nur "Prozess beendet", nicht hilfreich fürs
// Debugging). Bewusst klein gehalten, keine vollständige Log-Aggregation.
const crashStderrLines = 5

var (
	// ErrUnknownType wird geliefert, wenn Start() mit einem Typ
	// aufgerufen wird, der nicht im Katalog steht.
	ErrUnknownType = errors.New("launcher: unknown catalog type")
	// ErrUnsupportedRunner wird geliefert, wenn ein Katalog-Eintrag
	// einen anderen Runner als "process" verlangt (noch nicht
	// implementiert, ARCHITECTURE.md §6.2).
	ErrUnsupportedRunner = errors.New("launcher: unsupported runner")
	// ErrUnknownInstance wird geliefert, wenn Stop() mit einer
	// unbekannten Instanz-ID aufgerufen wird.
	ErrUnknownInstance = errors.New("launcher: unknown instance")
)

// stopGracePeriod ist die Wartezeit zwischen SIGTERM und SIGKILL beim
// Stoppen einer Instanz (UMSETZUNG.md C8: "SIGTERM, Grace, SIGKILL").
// Kein const, damit launcher_test.go sie für den SIGKILL-Testfall
// verkürzen kann, ohne 3s pro Testlauf zu warten.
var stopGracePeriod = 3 * time.Second

// Instance ist eine laufende (oder nach einem Orchestrator-Neustart per
// PID wiedererkannte) Node-Instanz.
type Instance struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Label string `json:"label"`
	PID   int    `json:"pid"`
	// Crashed ist gesetzt, wenn der Subprozess beendet wurde, ohne dass
	// Stop() ihn dazu gebracht hat (z. B. Pipeline-Init-Fehler). Anders
	// als ein per Stop() beendeter Prozess bleibt die Instanz dafür in
	// List() sichtbar, statt spurlos zu verschwinden, bis der Nutzer sie
	// per DELETE /api/v1/instances/<id> wegklickt oder neu startet.
	Crashed bool `json:"crashed,omitempty"`
	// CrashMessage ist der Wait()-Fehler plus die letzten
	// crashStderrLines Zeilen stderr der Instanz, nur gesetzt wenn Crashed.
	CrashMessage string `json:"crashMessage,omitempty"`
}

// EventPublisher verteilt ein SSE-Event an alle verbundenen Flow-Editor-
// Clients (implementiert von *sse.Hub) — optional, darf nil sein (z. B.
// in Tests), gleiches Muster wie graph.EventPublisher.
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Launcher startet/stoppt Node-Instanzen aus dem Katalog als lokale
// Subprozesse (os/exec) und hält deren {id, type, pid} persistent, damit
// ein Orchestrator-Neustart noch laufende Kind-Prozesse per PID-Check
// wiedererkennt statt sie zu verwaisen (UMSETZUNG.md C8).
type Launcher struct {
	catalog     []CatalogEntry
	registryURL string
	natsURL     string
	statePath   string
	events      EventPublisher

	mu        sync.Mutex
	instances map[string]Instance
}

// New erstellt einen Launcher und lädt einen zuvor persistierten Stand
// aus dataDir/instances.json — Einträge, deren PID keinem laufenden
// Prozess mehr entspricht, werden verworfen (der Kind-Prozess kann
// zwischen zwei Orchestrator-Läufen jederzeit beendet worden sein, das
// ist kein Fehler). events darf nil sein (z. B. in Tests).
func New(catalog []CatalogEntry, registryURL, natsURL, dataDir string, events EventPublisher) *Launcher {
	l := &Launcher{
		catalog:     catalog,
		registryURL: registryURL,
		natsURL:     natsURL,
		statePath:   filepath.Join(dataDir, "instances.json"),
		events:      events,
		instances:   map[string]Instance{},
	}
	l.loadState()
	return l
}

// Catalog liefert die geladenen Katalog-Einträge (GET /api/v1/catalog).
func (l *Launcher) Catalog() []CatalogEntry {
	return l.catalog
}

// List liefert alle aktuell bekannten Instanzen (GET /api/v1/instances).
func (l *Launcher) List() []Instance {
	l.mu.Lock()
	defer l.mu.Unlock()
	list := make([]Instance, 0, len(l.instances))
	for _, inst := range l.instances {
		list = append(list, inst)
	}
	return list
}

// Start sucht nodeType im Katalog, startet ihn als Subprozess mit
// OMP_INSTANCE_ID/OMP_LABEL/OMP_PORT=0 sowie den Registry-/NATS-URLs des
// Orchestrators (UMSETZUNG.md C8) und persistiert die neue Instanz. Die
// eigentliche Registry-Erscheinung läuft über die normale
// Selbstregistrierung des gestarteten Nodes — Start() fasst den Graph
// selbst nicht an.
func (l *Launcher) Start(nodeType string) (Instance, error) {
	entry, ok := l.findEntry(nodeType)
	if !ok {
		return Instance{}, ErrUnknownType
	}
	if entry.Runner != runnerProcess {
		return Instance{}, ErrUnsupportedRunner
	}

	id, err := newInstanceID()
	if err != nil {
		return Instance{}, fmt.Errorf("launcher: generate instance id: %w", err)
	}
	label := fmt.Sprintf("%s (%s)", entry.Label, id[:8])

	cmd := exec.Command(entry.Command[0], entry.Command[1:]...)
	cmd.Env = buildEnv(entry.Env, id, label, l.registryURL, l.natsURL)
	// Node-Ausgaben (Pipeline-Fehler etc.) an den Orchestrator-Log
	// weiterreichen statt sie im Subprozess verschwinden zu lassen —
	// kein eigenes Log-Aggregations-System für diesen Schritt. stderrTail
	// spiegelt zusätzlich die letzten Zeilen mit, als Kontext für eine
	// eventuelle Crash-Meldung (s.u.), ohne den Log-Passthrough anzufassen.
	stderrTail := newTailBuffer(crashStderrLines)
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, stderrTail)

	if err := cmd.Start(); err != nil {
		return Instance{}, fmt.Errorf("launcher: start %s: %w", nodeType, err)
	}

	inst := Instance{ID: id, Type: nodeType, Label: label, PID: cmd.Process.Pid}

	l.mu.Lock()
	l.instances[id] = inst
	if err := l.saveState(); err != nil {
		slog.Warn("launcher: failed to persist instance state", "error", err)
	}
	l.mu.Unlock()

	// Der Orchestrator ist Elternprozess und muss auf das Prozessende
	// warten, sonst bleibt ein Zombie zurück, auch wenn niemand DELETE
	// /api/v1/instances/<id> aufruft (Kind stirbt z. B. durch einen
	// Pipeline-Fehler von selbst). Ein solches unerwartetes Ende wird als
	// Crash markiert (Nutzerfund: vorher verschwand die Instanz einfach
	// spurlos aus der Kachel-Ansicht, sobald die NMOS-Registrierung
	// ablief, ohne jedes Signal in der UI).
	go func() {
		waitErr := cmd.Wait()

		l.mu.Lock()
		current, stillTracked := l.instances[id]
		if !stillTracked {
			// Stop() hat die Instanz bereits entfernt — erwartetes Ende.
			l.mu.Unlock()
			return
		}
		current.Crashed = true
		current.CrashMessage = crashMessage(waitErr, stderrTail.String())
		l.instances[id] = current
		if err := l.saveState(); err != nil {
			slog.Warn("launcher: failed to persist instance state", "error", err)
		}
		l.mu.Unlock()

		slog.Warn("launcher: instance exited unexpectedly", "id", id, "type", nodeType, "error", waitErr)
		l.publishCrash(current)
	}()

	return inst, nil
}

// publishCrash meldet ein "instance.crashed"-SSE-Event, falls ein
// EventPublisher konfiguriert ist (main.go verdrahtet den sse.Hub, Tests
// lassen es i. d. R. nil).
func (l *Launcher) publishCrash(inst Instance) {
	if l.events == nil {
		return
	}
	data, err := json.Marshal(inst)
	if err != nil {
		return
	}
	l.events.Broadcast(sse.Event{Type: "instance.crashed", Data: data})
}

// crashMessage baut die für Toast/Kachel-Tooltip angezeigte Meldung aus
// dem Wait()-Fehler (nil bei exit 0, z. B. ein Node, der sich selbst ohne
// Fehler beendet) und dem stderr-Tail des Subprozesses.
func crashMessage(waitErr error, stderrTail string) string {
	msg := "Prozess unerwartet beendet"
	if waitErr != nil {
		msg = waitErr.Error()
	}
	if stderrTail != "" {
		msg += ": " + stderrTail
	}
	return msg
}

// Stop trennt id — SIGTERM, Wartezeit stopGracePeriod, dann SIGKILL,
// falls der Prozess danach noch lebt (UMSETZUNG.md C8). id wird sofort
// aus dem persistierten Stand entfernt, unabhängig davon, wie lange das
// eigentliche Beenden dauert.
func (l *Launcher) Stop(id string) error {
	l.mu.Lock()
	inst, ok := l.instances[id]
	if ok {
		delete(l.instances, id)
		if err := l.saveState(); err != nil {
			slog.Warn("launcher: failed to persist instance state", "error", err)
		}
	}
	l.mu.Unlock()

	if !ok {
		return ErrUnknownInstance
	}

	process, err := os.FindProcess(inst.PID)
	if err != nil {
		return nil // Prozess existiert nicht mehr
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		return nil // wahrscheinlich schon beendet
	}

	deadline := time.Now().Add(stopGracePeriod)
	for time.Now().Before(deadline) {
		if !processAlive(inst.PID) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(inst.PID) {
		_ = process.Kill()
	}
	return nil
}

func (l *Launcher) findEntry(nodeType string) (CatalogEntry, bool) {
	for _, e := range l.catalog {
		if e.Type == nodeType {
			return e, true
		}
	}
	return CatalogEntry{}, false
}

func (l *Launcher) loadState() {
	data, err := os.ReadFile(l.statePath)
	if err != nil {
		return // keine Datei -> kein vorheriger Stand, kein Fehler
	}
	var saved []Instance
	if err := json.Unmarshal(data, &saved); err != nil {
		slog.Warn("launcher: failed to parse persisted instance state", "path", l.statePath, "error", err)
		return
	}
	for _, inst := range saved {
		if processAlive(inst.PID) {
			l.instances[inst.ID] = inst
		}
	}
	if err := l.saveState(); err != nil {
		slog.Warn("launcher: failed to rewrite instance state", "error", err)
	}
}

// saveState schreibt den aktuellen Instanzstand. Aufrufer müssen l.mu
// bereits halten (Ausnahme: loadState, vor jeder gemeinsamen Nutzung).
func (l *Launcher) saveState() error {
	list := make([]Instance, 0, len(l.instances))
	for _, inst := range l.instances {
		list = append(list, inst)
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.statePath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(l.statePath, data, 0o644)
}

// processAlive prüft per Signal 0 (Standard-Unix-Idiom, sendet kein
// echtes Signal), ob pid einem noch laufenden, für uns sichtbaren
// Prozess gehört. Bekannte Einschränkung: PID-Wiederverwendung durch das
// OS kann nach längerer Zeit fälschlich "lebt noch" ergeben — laut
// UMSETZUNG.md C8 akzeptierter Trade-off des einfachen PID-Checks.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

// buildEnv baut die Subprozess-Umgebung: geerbte Umgebung + Katalog-
// eigene env{} + die fünf vom Launcher vorgegebenen Variablen, die immer
// gewinnen (Korrektheitsgarantie: eine Instanz läuft unter der vom
// Launcher vergebenen ID und sucht sich selbst einen freien Port,
// UMSETZUNG.md C8) — als Map gemergt statt als Slice mit möglichen
// Duplikaten, weil doppelte Keys in envp technisch nicht sauber
// spezifiziert sind.
func buildEnv(entryEnv map[string]string, instanceID, label, registryURL, natsURL string) []string {
	merged := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			merged[kv[:i]] = kv[i+1:]
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

// tailBuffer ist ein io.Writer, der nebenläufig sicher die letzten
// maxLines geschriebenen Zeilen vorhält — Grundlage für crashMessage().
// Kein bufio.Scanner (der bräuchte einen io.Reader auf der Gegenseite);
// stattdessen zeilenweises Zerlegen der geschriebenen Bytes selbst, weil
// cmd.Stderr nur einen io.Writer erwartet.
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

// String liefert die zuletzt gepufferten Zeilen (inklusive einer noch
// nicht mit '\n' abgeschlossenen letzten Zeile), Newline-getrennt.
func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := b.lines
	if b.partial.Len() > 0 {
		lines = append(append([]string{}, lines...), b.partial.String())
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// newInstanceID erzeugt eine zufällige ID (gleiches Muster wie
// snapshots.newID — 16 Zufallsbytes hex-codiert, kein UUID-Format nötig,
// da der Wert nur als OMP_INSTANCE_ID/IS-04-Tag-Wert verwendet wird,
// keine eigene IS-04-Resource-ID ist).
func newInstanceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

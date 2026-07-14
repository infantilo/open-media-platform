// Package launcher startet/stoppt Node-Instanzen aus einem festen
// Katalog heraus (UMSETZUNG.md C8, ARCHITECTURE.md §6.2 "Stufe 0" des
// später geplanten vollen Workflow-Bereitstellungs-Konzepts): bewusst
// nur "starte ein bekanntes, vorgebautes Binary als Subprozess, mehrfach
// instanziierbar auf einem Host" — kein Rollen-Template, keine
// Platzierung, kein Bundle-Start.
//
// Seit D6 Teil 2 (ARCHITECTURE.md §18.5) optional **remote-fähig**: mit
// leerem hostID verhält sich Start()/Stop() exakt wie vor diesem
// Schritt (lokaler os/exec-Subprozess); mit gesetztem hostID gehen
// Start-/Stop-Kommandos stattdessen per NATS-Request/Reply an den
// passenden omp-host-agent (omp.host.<hostId>.cmd). Die Sicherheits-
// grenze "nur Katalog-Einträge, keine freien Kommandos" bleibt
// bestehen, wandert für den Remote-Fall aber zum Host-Agent (der
// prüft gegen seinen *eigenen* lokalen Katalog, s.
// host-agent/internal/catalog) — der Orchestrator schickt nur einen
// Typnamen, keinen Befehl (docs/decisions.md D6 Teil 2).
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
	// ErrRemoteUnavailable wird geliefert, wenn Start()/Stop() mit
	// gesetztem hostID aufgerufen wird, der Launcher aber ohne
	// NATSRequester konstruiert wurde (kein Kommandokanal verdrahtet).
	ErrRemoteUnavailable = errors.New("launcher: remote hosts not available (no NATS connection configured)")
)

// stopGracePeriod ist die Wartezeit zwischen SIGTERM und SIGKILL beim
// Stoppen einer Instanz (UMSETZUNG.md C8: "SIGTERM, Grace, SIGKILL").
// Kein const, damit launcher_test.go sie für den SIGKILL-Testfall
// verkürzen kann, ohne 3s pro Testlauf zu warten.
var stopGracePeriod = 3 * time.Second

// remoteCommandTimeout ist die Wartezeit auf die Antwort eines
// Host-Agent-Kommandos (§18.5) — deutlich über der Größenordnung eines
// Prozess-Starts (Registrierung selbst läuft asynchron danach), aber
// endlich, damit ein nicht erreichbarer/abgestürzter Host-Agent
// `POST /api/v1/instances` nicht unbegrenzt hängen lässt.
const remoteCommandTimeout = 5 * time.Second

// NATSRequester schickt eine Request/Reply-Anfrage über NATS
// (implementiert von einem schmalen Adapter um *nats.Conn in main.go —
// launcher.go bleibt dadurch frei von einer direkten nats.go-
// Abhängigkeit, gleiches Entkopplungsmuster wie EventPublisher/
// NodeLister in anderen Paketen). nil bedeutet "kein Kommandokanal
// verdrahtet" — Start()/Stop() mit einem hostID scheitern dann mit
// ErrRemoteUnavailable, rein lokaler Betrieb (hostID "") bleibt
// unberührt.
type NATSRequester interface {
	RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error)
}

// Instance ist eine laufende (oder nach einem Orchestrator-Neustart per
// PID wiedererkannte) Node-Instanz.
type Instance struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Label string `json:"label"`
	PID   int    `json:"pid"`
	// HostID ist die Host-Agent-ID, auf der diese Instanz läuft
	// (ARCHITECTURE.md §18.5, UMSETZUNG.md D6 Teil 2) — leer für lokal
	// (auf demselben Host wie der Orchestrator) gestartete Instanzen,
	// das vor D6 Teil 2 einzig existierende Verhalten.
	HostID string `json:"hostId,omitempty"`
	// Crashed ist gesetzt, wenn der Subprozess beendet wurde, ohne dass
	// Stop() ihn dazu gebracht hat (z. B. Pipeline-Init-Fehler). Anders
	// als ein per Stop() beendeter Prozess bleibt die Instanz dafür in
	// List() sichtbar, statt spurlos zu verschwinden, bis der Nutzer sie
	// per DELETE /api/v1/instances/<id> wegklickt oder neu startet.
	// Für entfernt gestartete Instanzen (HostID gesetzt) noch nicht
	// unterstützt (dokumentierte Folgearbeit, docs/decisions.md D6 Teil
	// 2 — der Host-Agent meldet einen Absturz noch nicht zurück).
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
	nc          NATSRequester

	mu        sync.Mutex
	instances map[string]Instance
}

// New erstellt einen Launcher und lädt einen zuvor persistierten Stand
// aus dataDir/instances.json — Einträge, deren PID keinem laufenden
// Prozess mehr entspricht, werden verworfen (der Kind-Prozess kann
// zwischen zwei Orchestrator-Läufen jederzeit beendet worden sein, das
// ist kein Fehler). events/nc dürfen nil sein (z. B. in Tests) — nc nil
// bedeutet "kein Kommandokanal", Start()/Stop() mit einem hostID
// scheitern dann mit ErrRemoteUnavailable statt einer Nil-Pointer-
// Panik; rein lokaler Betrieb funktioniert unverändert.
func New(catalog []CatalogEntry, registryURL, natsURL, dataDir string, events EventPublisher, nc NATSRequester) *Launcher {
	l := &Launcher{
		catalog:     catalog,
		registryURL: registryURL,
		natsURL:     natsURL,
		statePath:   filepath.Join(dataDir, "instances.json"),
		events:      events,
		nc:          nc,
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

// Start sucht nodeType im Katalog und startet ihn — lokal als
// Subprozess (hostID leer, UMSETZUNG.md C8) oder auf einem entfernten,
// per omp-host-agent registrierten Host (hostID gesetzt, §18.5,
// UMSETZUNG.md D6 Teil 2). Die eigentliche Registry-Erscheinung läuft
// in beiden Fällen über die normale Selbstregistrierung des gestarteten
// Nodes — Start() fasst den Graph selbst nicht an.
func (l *Launcher) Start(nodeType, hostID string) (Instance, error) {
	if hostID != "" {
		return l.startRemote(nodeType, hostID)
	}
	return l.startLocal(nodeType)
}

// startLocal — unverändertes Verhalten aus C8 (OMP_INSTANCE_ID/
// OMP_LABEL/OMP_PORT=0 sowie die Registry-/NATS-URLs des Orchestrators
// als Subprozess-Umgebung, Ergebnis persistiert).
func (l *Launcher) startLocal(nodeType string) (Instance, error) {
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

// startRemote schickt ein Start-Kommando an den Host-Agent von hostID
// (§18.5). Anders als startLocal prüft der Orchestrator hier **nicht**
// gegen seinen eigenen Katalog — er schickt nur den Typnamen, der
// Host-Agent löst ihn gegen seinen *eigenen* lokalen Katalog auf (die
// Sicherheitsgrenze "nur Katalog-Einträge" liegt für den Remote-Fall
// beim Agent, s. Paketkommentar). ErrUnknownType/ErrUnsupportedRunner
// werden deshalb hier nicht geprüft; ein unbekannter Typ auf dem
// Zielhost kommt als Fehler in der Kommando-Antwort zurück.
func (l *Launcher) startRemote(nodeType, hostID string) (Instance, error) {
	if l.nc == nil {
		return Instance{}, ErrRemoteUnavailable
	}

	id, err := newInstanceID()
	if err != nil {
		return Instance{}, fmt.Errorf("launcher: generate instance id: %w", err)
	}
	label := fmt.Sprintf("%s (%s)", nodeType, id[:8])

	resp, err := l.sendCommand(hostID, remoteCommand{
		Action:     "start",
		Type:       nodeType,
		InstanceID: id,
		Label:      label,
	})
	if err != nil {
		return Instance{}, fmt.Errorf("launcher: remote start on host %s: %w", hostID, err)
	}
	if !resp.OK {
		return Instance{}, fmt.Errorf("launcher: remote start on host %s failed: %s", hostID, resp.Error)
	}

	inst := Instance{ID: id, Type: nodeType, Label: label, PID: resp.PID, HostID: hostID}
	l.mu.Lock()
	l.instances[id] = inst
	if err := l.saveState(); err != nil {
		slog.Warn("launcher: failed to persist instance state", "error", err)
	}
	l.mu.Unlock()

	return inst, nil
}

// remoteCommand/remoteResponse spiegeln host-agent/internal/commands'
// Request/Response-Wire-Format (JSON über NATS-Request/Reply) —
// bewusst hier dupliziert statt importiert: host-agent ist ein
// eigenständiges Go-Modul (analog nodes/mock), kein gemeinsames
// drittes Paket für ein derart schmales Format.
type remoteCommand struct {
	Action     string `json:"action"`
	Type       string `json:"type,omitempty"`
	InstanceID string `json:"instanceId"`
	Label      string `json:"label,omitempty"`
}

type remoteResponse struct {
	OK    bool   `json:"ok"`
	PID   int    `json:"pid,omitempty"`
	Error string `json:"error,omitempty"`
}

func (l *Launcher) sendCommand(hostID string, cmd remoteCommand) (remoteResponse, error) {
	payload, err := json.Marshal(cmd)
	if err != nil {
		return remoteResponse{}, err
	}
	subject := fmt.Sprintf("omp.host.%s.cmd", hostID)
	data, err := l.nc.RequestBytes(subject, payload, remoteCommandTimeout)
	if err != nil {
		return remoteResponse{}, err
	}
	var resp remoteResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return remoteResponse{}, fmt.Errorf("decode response: %w", err)
	}
	return resp, nil
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
// Stop trennt id — lokal per SIGTERM/Wartezeit/SIGKILL (UMSETZUNG.md
// C8) oder, für eine mit HostID gestartete Instanz, per Stop-Kommando
// an den zuständigen Host-Agent (§18.5, UMSETZUNG.md D6 Teil 2). id
// wird in beiden Fällen sofort aus dem persistierten Stand entfernt,
// unabhängig davon, wie lange das eigentliche Beenden dauert.
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

	if inst.HostID != "" {
		return l.stopRemote(inst)
	}
	return l.stopLocal(inst)
}

func (l *Launcher) stopLocal(inst Instance) error {
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

func (l *Launcher) stopRemote(inst Instance) error {
	if l.nc == nil {
		return ErrRemoteUnavailable
	}
	resp, err := l.sendCommand(inst.HostID, remoteCommand{Action: "stop", InstanceID: inst.ID})
	if err != nil {
		return fmt.Errorf("launcher: remote stop on host %s: %w", inst.HostID, err)
	}
	if !resp.OK {
		return fmt.Errorf("launcher: remote stop on host %s failed: %s", inst.HostID, resp.Error)
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

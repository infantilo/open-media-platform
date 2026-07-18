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
	"strings"
	"sync"
	"sync/atomic"
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

// Crash-Loop-Bremse (ARCHITECTURE.md §6.3 Stufe 2, docs/END-GOAL-
// FEATURES.md §7.3a/§7.4 K7-Teil-1, Entscheidung docs/decisions.md
// 2026-07-14 "Entscheidungssitzung END-GOAL-FEATURES Kapitel 10" Punkt
// 8): maxCrashRestarts Neustarts innerhalb crashRestartWindow, danach
// wird eskaliert (Auto-Restart gestoppt, Instanz bleibt "crashed" statt
// endlos weiterzuversuchen wie im PIPELINE-CONTROLLER-Vorbild).
// crashRestartBackoff ist bewusst ein fester Delay (PIPELINE-
// CONTROLLER-Muster `supervisor.js:183–192`), keine exponentielle
// Backoff-Kurve — bei einem harten Obergrenzen-Cutoff ist die
// Eskalation selbst schon der Schutz vor einem hämmernden Neustart-
// Sturm, eine wachsende Verzögerung wäre zusätzliche Komplexität ohne
// zusätzlichen Nutzen hier.
// Bewusst (noch) kein Katalog-/Workflow-Rollen-Feld dafür (Ziel-Design
// nennt `restartPolicy{maxRestarts,backoffMs,window}` als spätere
// Ausbaustufe) — dieser erste Schritt deckt die im Phasenplan
// verlangte Verifikation (kill -9 -> Neustart -> Wiederverkabelung)
// mit einer für alle Instanzen einheitlichen Policy ab; pro-Typ/-Rolle
// Konfigurierbarkeit ist dokumentierte Folgearbeit, kein stiller Gap.
// var statt const: Tests verkürzen Fenster/Backoff, um nicht real 60s
// warten zu müssen (gleiches Muster wie stopGracePeriod).
var (
	maxCrashRestarts    = 5
	crashRestartWindow  = 60 * time.Second
	crashRestartBackoff = 2 * time.Second
)

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
	// RestartCount zählt automatische Neustarts nach einem unerwarteten
	// Prozessende seit dem ursprünglichen Start (K7-Teil-1) — nicht auf
	// das Crash-Loop-Fenster begrenzt, damit ein Operator im UI sieht,
	// wie oft eine Instanz insgesamt schon neu gestartet ist (gleiches
	// Prinzip wie PIPELINE CONTROLLERs `supervisor.js:412`-Zähler).
	RestartCount int `json:"restartCount,omitempty"`
	// ExtraEnv ist das beim ursprünglichen Start übergebene extraEnv
	// (s. Start-Doku) — für lokale Instanzen nur zur Vollständigkeit
	// mitgeführt (der eigentliche Neustart-Pfad liest es dort aus der
	// supervise()-Goroutine-Closure, nicht aus diesem Feld); für
	// entfernte Instanzen (S3) ist dieses Feld die **einzige** Quelle,
	// aus der HandleRemoteExit ein extraEnv beim automatischen Neustart
	// erneut mitschicken kann, weil es dort keine langlebige
	// Supervisor-Goroutine gibt, die es sich sonst merken könnte.
	ExtraEnv map[string]string `json:"extraEnv,omitempty"`
}

// EventPublisher verteilt ein SSE-Event an alle verbundenen Flow-Editor-
// Clients (implementiert von *sse.Hub) — optional, darf nil sein (z. B.
// in Tests), gleiches Muster wie graph.EventPublisher.
type EventPublisher interface {
	Broadcast(sse.Event)
}

// RestartObserver wird benachrichtigt, sobald der Launcher eine Instanz
// nach einem unerwarteten Prozessende automatisch neu gestartet hat
// (K7-Teil-1, docs/END-GOAL-FEATURES.md §7.3a) — implementiert von
// *workflows.Service, das daraufhin die betroffene Workflow-Rolle neu
// verkabelt (generalisiert den bisher nur an den Workflow-Start
// gebundenen node.added-Glue aus D7 Teil 1 auf "dieselbe Rolle ist
// nach einem Neustart wieder da"). Optional (darf unverdrahtet
// bleiben, z. B. in Tests) — ein manuell über den Katalog gestarteter
// Node ohne Workflow-Zugehörigkeit braucht keinen Beobachter.
type RestartObserver interface {
	InstanceRestarted(instanceID string)
}

// restartState hält die Crash-Loop-Buchführung einer Instanz (nicht
// persistiert — ein Orchestrator-Neustart ist ein anderer, bereits
// separat behandelter Fehlerfall, s. loadState).
type restartState struct {
	windowStart   time.Time
	countInWindow int
	total         int
}

// instanceStore ist die von Launcher genutzte Teilmenge von *Store —
// als Interface gehalten (gleiches Muster wie workflows.workflowStore),
// damit Launcher-Tests einen In-Memory-Fake statt einer echten
// Postgres-Verbindung einsetzen können, wo es nicht um die Persistenz
// selbst geht.
type instanceStore interface {
	Put(Instance) error
	Delete(id string) error
	List() ([]Instance, error)
}

// Launcher startet/stoppt Node-Instanzen aus dem Katalog als lokale
// Subprozesse (os/exec) und hält deren {id, type, pid} persistent (seit
// S4 in Postgres, `instances`-Tabelle, s. store.go — vorher
// data/instances.json), damit ein Orchestrator-Neustart noch laufende
// Kind-Prozesse per PID-Check wiedererkennt statt sie zu verwaisen
// (UMSETZUNG.md C8).
type Launcher struct {
	catalog         []CatalogEntry
	registryURL     string
	natsURL         string
	store           instanceStore
	events          EventPublisher
	nc              NATSRequester
	restartObserver RestartObserver

	mu        sync.Mutex
	instances map[string]Instance
	restarts  map[string]*restartState

	// totalRestarts zählt jeden tatsächlichen automatischen Neustart
	// (lokal wie remote, beide laufen durch recordRestartLocked) seit
	// Prozessstart kumulativ (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md:
	// "Launcher (Instanzen, Restarts)" für /metrics) — bewusst ein
	// eigener, nie sinkender Zähler statt der Summe der aktuell in
	// `instances` befindlichen `RestartCount`-Werte: Letztere sänke
	// fälschlich, sobald eine Instanz gestoppt/entfernt wird, was einen
	// Prometheus-Counter-Konsumenten (z. B. den S8-Soak-Test) in die
	// Irre führen würde.
	totalRestarts atomic.Uint64
}

// SetRestartObserver verdrahtet einen Beobachter für automatische
// Neustarts nach dem Konstruieren (main.go: workflows.Service braucht
// den Launcher als Konstruktor-Argument, kann also nicht schon selbst
// beim launcher.New()-Aufruf als Beobachter übergeben werden). Nicht
// nebenläufigkeitsgeschützt — vor dem ersten Start()-Aufruf verdrahten,
// wie die übrigen main.go-Service-Verkabelungen auch.
func (l *Launcher) SetRestartObserver(o RestartObserver) {
	l.restartObserver = o
}

// New erstellt einen Launcher und lädt einen zuvor in store
// persistierten Stand (S4: `instances`-Tabelle statt
// data/instances.json) — Einträge, deren PID keinem laufenden Prozess
// mehr entspricht, werden verworfen (der Kind-Prozess kann zwischen
// zwei Orchestrator-Läufen jederzeit beendet worden sein, das ist kein
// Fehler). events/nc dürfen nil sein (z. B. in Tests) — nc nil bedeutet
// "kein Kommandokanal", Start()/Stop() mit einem hostID scheitern dann
// mit ErrRemoteUnavailable statt einer Nil-Pointer-Panik; rein lokaler
// Betrieb funktioniert unverändert. Konkreter *Store-Parameter (statt
// des intern genutzten instanceStore-Interfaces) der Einfachheit halber
// für main.go — Tests im Paket selbst rufen stattdessen das
// unexportierte newWithStore mit einem In-Memory-Fake auf (gleiches
// Muster wie workflows.NewService/workflowStore).
func New(catalog []CatalogEntry, registryURL, natsURL string, store *Store, events EventPublisher, nc NATSRequester) *Launcher {
	return newWithStore(catalog, registryURL, natsURL, store, events, nc)
}

func newWithStore(catalog []CatalogEntry, registryURL, natsURL string, store instanceStore, events EventPublisher, nc NATSRequester) *Launcher {
	l := &Launcher{
		catalog:     catalog,
		registryURL: registryURL,
		natsURL:     natsURL,
		store:       store,
		events:      events,
		nc:          nc,
		instances:   map[string]Instance{},
		restarts:    map[string]*restartState{},
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

// TotalRestarts liefert die kumulative Anzahl automatischer Neustarts
// (lokal + remote) seit Prozessstart (S8) — s. totalRestarts-Doku.
func (l *Launcher) TotalRestarts() uint64 {
	return l.totalRestarts.Load()
}

// Start sucht nodeType im Katalog und startet ihn — lokal als
// Subprozess (hostID leer, UMSETZUNG.md C8) oder auf einem entfernten,
// per omp-host-agent registrierten Host (hostID gesetzt, §18.5,
// UMSETZUNG.md D6 Teil 2). Die eigentliche Registry-Erscheinung läuft
// in beiden Fällen über die normale Selbstregistrierung des gestarteten
// Nodes — Start() fasst den Graph selbst nicht an.
// Start startet nodeType — lokal (hostID leer) oder auf einem entfernten
// Host (§18.5). extraEnv überschreibt den Katalog-eigenen `env`-Block
// für passende Schlüssel, gewinnt aber nie gegen die fünf vom Launcher
// selbst vorgegebenen OMP_*-Variablen (s. `buildEnv`) — gedacht für
// Workflow-Settings wie die Programm-Auflösung (Kapitel 15,
// docs/END-GOAL-FEATURES.md §15.3c), die pro Workflow-Start variieren,
// ohne den Katalog selbst zu ändern. Darf nil sein (z. B. ein direkter
// Katalog-Start über die Palette, ohne Workflow-Kontext).
// Seit S3 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) auch für Remote-
// Starts wirksam — der Host-Agent prüft jeden extraEnv-Schlüssel gegen
// seine eigene Allowlist (host-agent/internal/commands.
// allowedExtraEnvKeys, zunächst nur OMP_WIDTH/OMP_HEIGHT) und lehnt die
// gesamte Start-Anfrage ab, wenn ein nicht gelisteter Schlüssel dabei
// ist — die Sicherheitsgrenze aus dem Paketkommentar ("nur
// Katalog-Einträge, keine freien Kommandos") bleibt intakt, sie gilt
// jetzt zusätzlich für Umgebungsvariablen statt nur für den Node-Typ.
func (l *Launcher) Start(nodeType, hostID string, extraEnv map[string]string) (Instance, error) {
	if hostID != "" {
		return l.startRemote(nodeType, hostID, extraEnv)
	}
	return l.startLocal(nodeType, extraEnv)
}

// startLocal — unverändertes Verhalten aus C8 (OMP_INSTANCE_ID/
// OMP_LABEL/OMP_PORT=0 sowie die Registry-/NATS-URLs des Orchestrators
// als Subprozess-Umgebung, Ergebnis persistiert) plus optionales
// extraEnv (s. `Start`-Doku).
func (l *Launcher) startLocal(nodeType string, extraEnv map[string]string) (Instance, error) {
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

	cmd, stderrTail, err := l.execEntry(entry, id, label, extraEnv)
	if err != nil {
		return Instance{}, fmt.Errorf("launcher: start %s: %w", nodeType, err)
	}

	inst := Instance{ID: id, Type: nodeType, Label: label, PID: cmd.Process.Pid, ExtraEnv: extraEnv}

	l.mu.Lock()
	l.instances[id] = inst
	if err := l.persistInstanceLocked(id); err != nil {
		slog.Warn("launcher: failed to persist instance state", "error", err)
	}
	l.mu.Unlock()

	// Der Orchestrator ist Elternprozess und muss auf das Prozessende
	// warten, sonst bleibt ein Zombie zurück, auch wenn niemand DELETE
	// /api/v1/instances/<id> aufruft (Kind stirbt z. B. durch einen
	// Pipeline-Fehler von selbst). supervise behandelt ein solches
	// unerwartetes Ende: automatischer Neustart in derselben Instanz-ID
	// (K7-Teil-1), solange die Crash-Loop-Bremse nicht greift — vorher
	// verschwand die Instanz einfach spurlos aus der Kachel-Ansicht,
	// sobald die NMOS-Registrierung ablief, ohne jedes Signal in der UI.
	// extraEnv wandert mit, damit ein automatischer Neustart dieselben
	// Workflow-Settings (z. B. Auflösung) wieder anwendet, nicht die
	// Katalog-Defaults.
	go l.supervise(id, nodeType, entry, label, extraEnv, cmd, stderrTail)

	return inst, nil
}

// execEntry startet den Subprozess für einen Katalog-Eintrag unter einer
// gegebenen (bei einem Neustart: wiederverwendeten) Instanz-ID/-Label —
// gemeinsamer Kern von startLocal und supervise's Neustart-Zweig.
func (l *Launcher) execEntry(entry CatalogEntry, id, label string, extraEnv map[string]string) (*exec.Cmd, *tailBuffer, error) {
	cmd := exec.Command(entry.Command[0], entry.Command[1:]...)
	cmd.Env = buildEnv(entry.Env, extraEnv, id, label, l.registryURL, l.natsURL)
	// Node-Ausgaben (Pipeline-Fehler etc.) an den Orchestrator-Log
	// weiterreichen statt sie im Subprozess verschwinden zu lassen —
	// kein eigenes Log-Aggregations-System für diesen Schritt. stderrTail
	// spiegelt zusätzlich die letzten Zeilen mit, als Kontext für eine
	// eventuelle Crash-Meldung, ohne den Log-Passthrough anzufassen.
	stderrTail := newTailBuffer(crashStderrLines)
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.MultiWriter(os.Stderr, stderrTail)

	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return cmd, stderrTail, nil
}

// supervise wartet auf das Prozessende einer lokalen Instanz und
// startet sie bei einem unerwarteten Ende automatisch neu, in derselben
// Instanz-ID (K7-Teil-1, docs/END-GOAL-FEATURES.md §7.3a) — solange die
// Crash-Loop-Bremse (maxCrashRestarts je crashRestartWindow) das
// zulässt. Läuft als eigene Goroutine je Instanz, endet entweder wenn
// Stop() die Instanz aus l.instances entfernt hat oder wenn die
// Crash-Loop-Bremse greift.
func (l *Launcher) supervise(id, nodeType string, entry CatalogEntry, label string, extraEnv map[string]string, cmd *exec.Cmd, stderrTail *tailBuffer) {
	for {
		waitErr := cmd.Wait()

		l.mu.Lock()
		current, stillTracked := l.instances[id]
		if !stillTracked {
			// Stop() hat die Instanz bereits entfernt — erwartetes Ende.
			l.mu.Unlock()
			return
		}
		msg := crashMessage(waitErr, stderrTail.String())
		shouldRestart, restartCount := l.recordRestartLocked(id)
		if !shouldRestart {
			current.Crashed = true
			current.CrashMessage = fmt.Sprintf(
				"%s (Crash-Loop erkannt: %d Neustarts in %s — Auto-Restart gestoppt)",
				msg, maxCrashRestarts, crashRestartWindow)
			current.RestartCount = restartCount
			l.instances[id] = current
			if err := l.persistInstanceLocked(id); err != nil {
				slog.Warn("launcher: failed to persist instance state", "error", err)
			}
			l.mu.Unlock()

			slog.Warn("launcher: crash loop detected, giving up auto-restart",
				"id", id, "type", nodeType, "restarts", restartCount)
			l.publishCrash(current)
			return
		}
		l.mu.Unlock()

		slog.Warn("launcher: instance exited unexpectedly, restarting",
			"id", id, "type", nodeType, "error", waitErr, "attempt", restartCount)
		time.Sleep(crashRestartBackoff)

		l.mu.Lock()
		if _, stillTracked := l.instances[id]; !stillTracked {
			// Stop() während des Backoffs — nicht mehr neu starten.
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()

		newCmd, newStderrTail, err := l.execEntry(entry, id, label, extraEnv)
		if err != nil {
			l.mu.Lock()
			current, stillTracked := l.instances[id]
			if stillTracked {
				current.Crashed = true
				current.CrashMessage = fmt.Sprintf("Neustart fehlgeschlagen: %v", err)
				current.RestartCount = restartCount
				l.instances[id] = current
				if saveErr := l.persistInstanceLocked(id); saveErr != nil {
					slog.Warn("launcher: failed to persist instance state", "error", saveErr)
				}
			}
			l.mu.Unlock()
			if stillTracked {
				l.publishCrash(current)
			}
			return
		}

		l.mu.Lock()
		current, stillTracked = l.instances[id]
		if !stillTracked {
			// Stop() lief exakt während des Neustarts — den frisch
			// gestarteten Ersatzprozess wieder beenden, nicht verwaisen
			// lassen.
			l.mu.Unlock()
			_ = newCmd.Process.Kill()
			return
		}
		current.PID = newCmd.Process.Pid
		current.Crashed = false
		current.CrashMessage = ""
		current.RestartCount = restartCount
		l.instances[id] = current
		if err := l.persistInstanceLocked(id); err != nil {
			slog.Warn("launcher: failed to persist instance state", "error", err)
		}
		l.mu.Unlock()

		l.publishRestarted(current)
		if l.restartObserver != nil {
			l.restartObserver.InstanceRestarted(id)
		}

		cmd, stderrTail = newCmd, newStderrTail
	}
}

// recordRestartLocked führt die Crash-Loop-Buchführung für id fort und
// meldet, ob noch ein automatischer Neustart erlaubt ist. Aufrufer muss
// l.mu bereits halten.
func (l *Launcher) recordRestartLocked(id string) (shouldRestart bool, totalRestarts int) {
	st, ok := l.restarts[id]
	now := time.Now()
	if !ok || now.Sub(st.windowStart) > crashRestartWindow {
		st = &restartState{windowStart: now}
		l.restarts[id] = st
	}
	st.countInWindow++
	st.total++
	l.totalRestarts.Add(1)
	if st.countInWindow > maxCrashRestarts {
		return false, st.total
	}
	return true, st.total
}

// startRemote schickt ein Start-Kommando an den Host-Agent von hostID
// (§18.5). Anders als startLocal prüft der Orchestrator hier **nicht**
// gegen seinen eigenen Katalog — er schickt nur den Typnamen, der
// Host-Agent löst ihn gegen seinen *eigenen* lokalen Katalog auf (die
// Sicherheitsgrenze "nur Katalog-Einträge" liegt für den Remote-Fall
// beim Agent, s. Paketkommentar). ErrUnknownType/ErrUnsupportedRunner
// werden deshalb hier nicht geprüft; ein unbekannter Typ auf dem
// Zielhost kommt als Fehler in der Kommando-Antwort zurück. extraEnv
// (S3) wird mitgeschickt — der Host-Agent prüft es gegen seine eigene
// Allowlist, s. `Start`-Doku.
func (l *Launcher) startRemote(nodeType, hostID string, extraEnv map[string]string) (Instance, error) {
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
		ExtraEnv:   extraEnv,
	})
	if err != nil {
		return Instance{}, fmt.Errorf("launcher: remote start on host %s: %w", hostID, err)
	}
	if !resp.OK {
		return Instance{}, fmt.Errorf("launcher: remote start on host %s failed: %s", hostID, resp.Error)
	}

	inst := Instance{ID: id, Type: nodeType, Label: label, PID: resp.PID, HostID: hostID, ExtraEnv: extraEnv}
	l.mu.Lock()
	l.instances[id] = inst
	if err := l.persistInstanceLocked(id); err != nil {
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
	Action     string            `json:"action"`
	Type       string            `json:"type,omitempty"`
	InstanceID string            `json:"instanceId"`
	Label      string            `json:"label,omitempty"`
	ExtraEnv   map[string]string `json:"extraEnv,omitempty"`
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

// remoteExitEvent spiegelt host-agent/internal/commands.ExitEvent
// (bewusst dupliziert, s. remoteCommand-Kommentar oben).
type remoteExitEvent struct {
	InstanceID string `json:"instanceId"`
	ExitCode   int    `json:"exitCode"`
	StderrTail string `json:"stderrTail,omitempty"`
}

// HandleRemoteExit verarbeitet ein vom Host-Agent gemeldetes
// unerwartetes Prozessende (S3, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md
// — omp.host.<hostId>.events, main.go verdrahtet dies an eine eigene
// NATS-Subscription). Remote-Pendant zu supervise()'s lokalem
// cmd.Wait()-Ende: gleiche Crash-Loop-Bremse (recordRestartLocked),
// gleiche instance.crashed/instance.restarted-Events, Neustart als
// Remote-Start-Kommando statt eines lokalen os/exec-Aufrufs. hostID
// kommt aus dem NATS-Subject, nicht aus dem Payload — der Host-Agent
// kann laut NATS-Subject-Konvention nur für sich selbst Events
// veröffentlichen, nie im Namen eines anderen Hosts (dieselbe
// Vertrauensgrenze wie bei omp.host.<hostId>.metrics).
func (l *Launcher) HandleRemoteExit(hostID string, payload []byte) {
	var ev remoteExitEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		slog.Warn("launcher: malformed remote exit event", "host_id", hostID, "error", err)
		return
	}
	if ev.InstanceID == "" {
		return
	}

	l.mu.Lock()
	current, tracked := l.instances[ev.InstanceID]
	l.mu.Unlock()
	if !tracked || current.HostID != hostID {
		// Unbekannte/fremde Instanz — z. B. ein bereits per Stop()
		// entfernter Eintrag, dessen Exit-Event nach der lokalen
		// Buchführung ankam (Race zwischen Stop() und Prozessende,
		// gleiche Race-Klasse wie beim lokalen supervise(), s. dortige
		// "noch in l.instances getrackt?"-Prüfung).
		return
	}

	msg := ev.StderrTail
	if msg == "" {
		msg = "Prozess unerwartet beendet"
	}
	if ev.ExitCode != 0 {
		msg = fmt.Sprintf("exit code %d: %s", ev.ExitCode, msg)
	}

	l.mu.Lock()
	shouldRestart, restartCount := l.recordRestartLocked(ev.InstanceID)
	if !shouldRestart {
		current.Crashed = true
		current.CrashMessage = fmt.Sprintf(
			"%s (Crash-Loop erkannt: %d Neustarts in %s — Auto-Restart gestoppt)",
			msg, maxCrashRestarts, crashRestartWindow)
		current.RestartCount = restartCount
		l.instances[ev.InstanceID] = current
		if err := l.persistInstanceLocked(ev.InstanceID); err != nil {
			slog.Warn("launcher: failed to persist instance state", "error", err)
		}
		l.mu.Unlock()

		slog.Warn("launcher: remote crash loop detected, giving up auto-restart",
			"id", ev.InstanceID, "host_id", hostID, "restarts", restartCount)
		l.publishCrash(current)
		return
	}
	l.mu.Unlock()

	slog.Warn("launcher: remote instance exited unexpectedly, restarting",
		"id", ev.InstanceID, "host_id", hostID, "exit_code", ev.ExitCode, "attempt", restartCount)
	time.Sleep(crashRestartBackoff)

	l.mu.Lock()
	current, tracked = l.instances[ev.InstanceID]
	l.mu.Unlock()
	if !tracked {
		// Stop() während des Backoffs — nicht mehr neu starten.
		return
	}

	resp, err := l.sendCommand(hostID, remoteCommand{
		Action:     "start",
		Type:       current.Type,
		InstanceID: ev.InstanceID,
		Label:      current.Label,
		ExtraEnv:   current.ExtraEnv,
	})
	if err != nil || !resp.OK {
		errMsg := resp.Error
		if err != nil {
			errMsg = err.Error()
		}
		l.mu.Lock()
		current, tracked = l.instances[ev.InstanceID]
		if tracked {
			current.Crashed = true
			current.CrashMessage = fmt.Sprintf("Neustart fehlgeschlagen: %s", errMsg)
			current.RestartCount = restartCount
			l.instances[ev.InstanceID] = current
			if saveErr := l.persistInstanceLocked(ev.InstanceID); saveErr != nil {
				slog.Warn("launcher: failed to persist instance state", "error", saveErr)
			}
		}
		l.mu.Unlock()
		if tracked {
			l.publishCrash(current)
		}
		return
	}

	l.mu.Lock()
	current, tracked = l.instances[ev.InstanceID]
	if !tracked {
		// Stop() lief exakt während des Neustart-Kommandos — den frisch
		// gestarteten Ersatzprozess wieder stoppen, nicht verwaisen
		// lassen (gleiches Prinzip wie supervise()'s "newCmd.Process.Kill()").
		l.mu.Unlock()
		_, _ = l.sendCommand(hostID, remoteCommand{Action: "stop", InstanceID: ev.InstanceID})
		return
	}
	current.PID = resp.PID
	current.Crashed = false
	current.CrashMessage = ""
	current.RestartCount = restartCount
	l.instances[ev.InstanceID] = current
	if err := l.persistInstanceLocked(ev.InstanceID); err != nil {
		slog.Warn("launcher: failed to persist instance state", "error", err)
	}
	l.mu.Unlock()

	l.publishRestarted(current)
	if l.restartObserver != nil {
		l.restartObserver.InstanceRestarted(ev.InstanceID)
	}
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

// publishRestarted meldet einen erfolgreichen automatischen Neustart
// (K7-Teil-1) — eigener Event-Typ statt einer Variante von
// "instance.crashed", damit die UI zwischen "hängt tot in crashed" und
// "hat sich selbst erholt" unterscheiden kann, statt beides gleich rot
// darzustellen.
func (l *Launcher) publishRestarted(inst Instance) {
	if l.events == nil {
		return
	}
	data, err := json.Marshal(inst)
	if err != nil {
		return
	}
	l.events.Broadcast(sse.Event{Type: "instance.restarted", Data: data})
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
		// Crash-Loop-Buchführung endet mit der Instanz — ein bewusst
		// gestoppter, später erneut gestarteter Node (neue Instanz-ID)
		// fängt bei der Bremse wieder bei null an.
		delete(l.restarts, id)
		if err := l.store.Delete(id); err != nil {
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
	saved, err := l.store.List()
	if err != nil {
		slog.Warn("launcher: failed to read persisted instance state", "error", err)
		return
	}
	for _, inst := range saved {
		if processAlive(inst.PID) {
			l.instances[inst.ID] = inst
		} else if err := l.store.Delete(inst.ID); err != nil {
			slog.Warn("launcher: failed to drop dead instance from persisted state", "id", inst.ID, "error", err)
		}
	}
}

// persistInstanceLocked schreibt den aktuellen Stand von id (S4: in die
// `instances`-Tabelle statt der früheren instances.json-Komplettdatei —
// ein gezieltes Upsert der einen geänderten Instanz statt eines
// Voll-Dumps aller Instanzen bei jeder Änderung). Aufrufer muss l.mu
// bereits halten und id muss in l.instances existieren.
func (l *Launcher) persistInstanceLocked(id string) error {
	return l.store.Put(l.instances[id])
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
func buildEnv(entryEnv, extraEnv map[string]string, instanceID, label, registryURL, natsURL string) []string {
	merged := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			merged[kv[:i]] = kv[i+1:]
		}
	}
	for k, v := range entryEnv {
		merged[k] = v
	}
	// extraEnv (z. B. Workflow-Settings wie die Auflösung, s. Start-Doku)
	// überschreibt den Katalog-eigenen env-Block, aber nicht die fünf
	// folgenden Launcher-eigenen Variablen.
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

package workflows

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// crosspointMethod beschreibt, wie eine Zielrolle ohne IS-04-Receiver
// (s. Connection-Doku in types.go) einen Quell-Sender als aktiven
// Eingang übernimmt: Node-Typ → Methodenname + Name des
// Sender-ID-Arguments, direkt aus dem jeweiligen Node-Quelltext
// übernommen (nicht geraten, UMSETZUNG.md §0 Punkt 6):
// nodes/omp-switcher/src/main.rs ("select"), nodes/omp-video-mixer-me/
// src/main.rs ("crosspoint.take" — setzt PGM sofort, ohne den
// gestagten Preset-Wert zu berühren).
//
// omp-audio-mixer bewusst nicht enthalten: dessen Eingänge sind an
// dynamisch angelegte Kanäle gebunden (channel.<id>.setSource), das
// bräuchte zusätzlich Kanal-Anlage/-Zuordnung im Workflow-Template —
// dokumentierte Folgearbeit, nicht Teil dieses Schritts.
// InputsParam ist der Name des Nodes-eigenen (readonly) Parameters, der
// die automatisch entdeckten Eingänge als [{senderId, label}, …] listet
// (beide Node-Typen liefern dasselbe Shape, nur unter verschiedenem
// Namen) — gebraucht von waitForCrosspointInput unten: der Zielnode baut
// seine GStreamer-Eingangs-Pads erst auf, sobald sein eigener
// discovery_loop (Poll-Intervall z. B. 2 s) den Sender selbst gesehen
// hat. Ein Take()/select() davor träfe auf keinen Pad — live gefunden
// 2026-07-18 (docs/decisions.md): der Node verwirft eine solche Auswahl
// kommentarlos (switch_isel() fällt auf "kein Programm" zurück und hat
// keinen Selbstheilungs-Mechanismus für später erscheinende Pads).
type crosspointMethod struct {
	Method      string
	Arg         string
	InputsParam string
}

var crosspointByNodeType = map[string]crosspointMethod{
	"omp-switcher":       {Method: "select", Arg: "senderId", InputsParam: "inputs"},
	"omp-video-mixer-me": {Method: "crosspoint.take", Arg: "senderId", InputsParam: "crosspoint.inputs"},
}

// registrationTimeout ist die Höchstdauer, die Start() auf das
// Erscheinen aller provisionierten Rollen in der NMOS-Registry wartet,
// bevor der Workflow als "failed" markiert wird — großzügig bemessen für
// reale GStreamer-Node-Startzeiten (Pipeline-Aufbau + Discovery), aber
// endlich, damit ein hängender Node den Workflow nicht für immer in
// "starting" belässt.
// var statt const: Tests überschreiben diese Werte, um nicht 20s auf
// einen absichtlich nie erscheinenden Test-Node warten zu müssen
// (gleiches Muster wie launcher.stopGracePeriod).
var registrationTimeout = 20 * time.Second

var registrationPollInterval = 300 * time.Millisecond

var (
	// ErrValidation wird bei einer ungültigen Workflow-Definition
	// geliefert (leere Rollen, doppelte Rollennamen, Verbindungs-Template
	// verweist auf unbekannte Rolle).
	ErrValidation = errors.New("workflows: invalid definition")
	// ErrNotStopped wird geliefert, wenn eine Operation (Löschen, Start)
	// einen gestoppten Workflow verlangt, der Workflow aber gerade läuft
	// oder gestartet wird.
	ErrNotStopped = errors.New("workflows: workflow is not stopped")
	// ErrNotRunning wird geliefert, wenn Stop() auf einen Workflow
	// aufgerufen wird, der nicht gestartet/fehlgeschlagen ist.
	ErrNotRunning = errors.New("workflows: workflow is not running")
	// ErrConfirmationRequired wird von Stop() geliefert, wenn
	// Definition.Settings.ConfirmStop gesetzt ist und der Aufruf ohne
	// confirm=true erfolgte (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 2).
	ErrConfirmationRequired = errors.New("workflows: stop requires confirmation")
	// ErrResourcesUnavailable wird von Start() geliefert, wenn die
	// Ressourcen-Vorprüfung (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 3)
	// mindestens einen Ziel-Host als aktuell nicht platzierbar meldet —
	// vor jedem Provisionieren geprüft, kein Teil-Start.
	ErrResourcesUnavailable = errors.New("workflows: resources unavailable")
)

// NodeLister liefert den zuletzt bekannten Node-Snapshot (implementiert
// von *registry.Store).
type NodeLister interface {
	List() []registry.NodeView
}

// GraphService ist die von Service genutzte Teilmenge von *graph.Service.
type GraphService interface {
	Connect(ctx context.Context, fromSender, toReceiver string) error
}

// Launcher startet/stoppt einzelne Node-Instanzen — lokal oder remote
// (implementiert von *launcher.Launcher, UMSETZUNG.md C8/D6 Teil 2). Ein
// Workflow-Start ist aus Launcher-Sicht nichts anderes als mehrere
// gebündelte Start-Aufrufe.
type Launcher interface {
	// Start-Signatur seit §17 Teil 5 um `version` erweitert
	// (docs/END-GOAL-FEATURES.md §17.4 Teil 5: mehrere Versionen
	// desselben importierten Typs) — Workflows referenzieren Rollen
	// bislang nur über NodeType, nie über eine Version, deshalb ruft
	// service.go Start hier immer mit version="" auf (unverändertes
	// Verhalten: löst sich wie vor §17 Teil 5 auf, solange der Typ nicht
	// mehrdeutig mehrfach importiert wurde).
	Start(nodeType, version, hostID string, extraEnv map[string]string) (launcher.Instance, error)
	Stop(id string) error
	// Catalog liefert die bekannten Node-Typen (Kapitel 12 Teil 3,
	// §12.3d: Import validiert unbekannte nodeType-Werte dagegen, statt
	// einen Import-Torso anzulegen).
	Catalog() []launcher.CatalogEntry
}

// EventPublisher verteilt ein SSE-Event an alle verbundenen Flow-Editor-
// Clients (implementiert von *sse.Hub) — informiert die UI über
// Statuswechsel während Start()/Stop() im Hintergrund laufen, ohne dass
// sie pollen muss (gleiches Muster wie graph.EventPublisher).
type EventPublisher interface {
	Broadcast(sse.Event)
}

type workflowStore interface {
	Put(wf Workflow) error
	Get(id string) (Workflow, error)
	List() ([]Workflow, error)
	Delete(id string) error
	UpdateSchedules(id string, schedules []Schedule) error
	UpdateRuntime(wf Workflow) error
	// SetThumbnail/GetThumbnail (Kapitel 12 Teil 6, §22.3 Punkt 5).
	SetThumbnail(id string, jpeg []byte) error
	GetThumbnail(id string) ([]byte, bool, error)
}

// ResourcePrecheck prüft, ob ein Host aktuell neue Rollen aufnehmen darf
// (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 3: "harte Vorbedingung" statt
// der advisory-only Placement-Engine aus §6.1/D6 Teil 3). Implementiert
// von *placement.Engine (CheckHost), die dieselben Alarm-Schwellwerte
// wiederverwendet, die bereits die Hosts-Ansicht/Alarm-View zeigen —
// bewusst kein drittes Schwellwert-Konzept.
type ResourcePrecheck interface {
	// CheckHost liefert (Ablehnungsgrund, ok) für den Start von nodeType
	// auf hostID. ok=true bei freien Ressourcen ODER fehlender Telemetrie
	// (fail-open — ein gerade erst registrierter Host ohne Messwerte ist
	// kein Blocker, gleiche Haltung wie placement.Engine.evaluateOnce bei
	// fehlenden Daten). Seit Kapitel 14 Teil 4 rechnet die Prüfung mit dem
	// Verbrauchsprofil von nodeType (falls bekannt), nicht mehr nur mit
	// dem aktuellen Momentwert des Hosts (docs/END-GOAL-FEATURES.md
	// §14.4 Teil 4).
	CheckHost(hostID, nodeType string) (reason string, ok bool)
}

// Service verwaltet Workflow-Definitionen und führt Bundle-Start/-Stop
// aus (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1/Teil 2).
type Service struct {
	store     workflowStore
	nodes     NodeLister
	graph     GraphService
	launcher  Launcher
	events    EventPublisher
	methods   methodInvoker
	resources ResourcePrecheck
	// httpClient (Kapitel 12 Teil 6, §22.3 Punkt 5): derselbe ggf.
	// mTLS-fähige Client wie methods, hier zusätzlich direkt gehalten,
	// weil captureThumbnail() den rohen MJPEG-Multipart-Body liest
	// (methodInvoker kennt nur das {"value": ...}-Parameter-Format).
	httpClient *http.Client
}

// NewService verbindet Postgres-Store, Node-Registry-Sicht, Graph-Service
// und Instanz-Launcher zu einem Workflow-Service. events darf nil sein
// (z. B. in Tests) — dann bleiben Statuswechsel SSE-still, nur per Poll
// sichtbar. httpClient ist der ggf. mTLS-fähige Client für
// Crosspoint-Methodenaufrufe (s. crosspointByNodeType) — nil bedeutet
// http.DefaultClient (gleiches Muster wie snapshots.NewService).
// resources darf nil sein (z. B. in Tests oder falls die Placement-
// Engine nicht verdrahtet ist) — dann entfällt die Ressourcen-
// Vorprüfung ersatzlos (kein neuer Blocker ohne Datengrundlage).
func NewService(store *Store, nodes NodeLister, graphSvc GraphService, l Launcher, events EventPublisher, httpClient *http.Client, resources ResourcePrecheck) *Service {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Service{store: store, nodes: nodes, graph: graphSvc, launcher: l, events: events, methods: newHTTPMethodInvoker(httpClient), resources: resources, httpClient: httpClient}
}

// Create legt einen neuen, gestoppten Workflow an.
func (s *Service) Create(name string, def Definition) (Workflow, error) {
	if err := validate(def); err != nil {
		return Workflow{}, err
	}
	id, err := newID()
	if err != nil {
		return Workflow{}, err
	}
	now := time.Now()
	wf := Workflow{
		ID:         id,
		Name:       name,
		Definition: def,
		Status:     StatusStopped,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.store.Put(wf); err != nil {
		return Workflow{}, err
	}
	// S2 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), live-verifiziert
	// per CDP gefunden: Create() fehlte bisher als einziger Schreibpfad
	// das publish() — ein extern (nicht über workflows-view.ts' eigenes
	// #createWorkflow()) angelegter Workflow blieb in jedem anderen
	// offenen Tab bis zum 30s-Fallback-Poll unsichtbar.
	s.publish(wf)
	return wf, nil
}

// List liefert alle gespeicherten Workflows.
func (s *Service) List() ([]Workflow, error) {
	return s.store.List()
}

// Get liefert einen einzelnen Workflow.
func (s *Service) Get(id string) (Workflow, error) {
	return s.store.Get(id)
}

// GetThumbnail liefert das zuletzt erfasste Vorschau-Bild eines
// Workflows (Kapitel 12 Teil 6, §22.3 Punkt 5) — ok=false, wenn noch
// nie eines erfasst wurde (s. Store.GetThumbnail-Doku).
func (s *Service) GetThumbnail(id string) ([]byte, bool, error) {
	return s.store.GetThumbnail(id)
}

// FindRoleForNode löst auf, ob nodeID aktuell eine Rolle in einem
// Workflow erfüllt (Kapitel 12 Teil 4, docs/END-GOAL-FEATURES.md
// §12.3e: Workflow-Scope-AuthZ) — genutzt von httpapi.requireVerbOnNode
// und consoles.Resolve, um eine Node-ID auf einen stabilen
// (Workflow, Rolle)-Wirkungsbereich abzubilden, statt sich auf die pro
// Prozessstart neue Node-ID selbst zu verlassen. ok=false, wenn der
// Node zu keinem (noch bekannten) Workflow gehört — z. B. eine manuell
// über den Katalog gestartete Instanz. workflowName ist der
// Definition.Title (Kapitel 12 Teil 6), sofern gesetzt — sonst der
// Name als Fallback (unverändertes Verhalten für Workflows ohne
// Metadaten); die Operator-Konsolen-Auswahl (Kapitel 12 Teil 5) zeigt
// diesen Wert als Kachel-Beschriftung.
func (s *Service) FindRoleForNode(nodeID string) (workflowID, workflowName, role string, ok bool) {
	wfs, err := s.store.List()
	if err != nil {
		return "", "", "", false
	}
	for _, wf := range wfs {
		for r, rt := range wf.Runtime {
			if rt.NodeID == nodeID {
				label := wf.Definition.Title
				if label == "" {
					label = wf.Name
				}
				return wf.ID, label, r, true
			}
		}
	}
	return "", "", "", false
}

// Delete entfernt einen Workflow — nur im Zustand "stopped" (kein
// stilles Verwaisen laufender Prozesse: erst stoppen, dann löschen).
func (s *Service) Delete(id string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStopped && wf.Status != StatusPaused {
		return ErrNotStopped
	}
	if err := s.store.Delete(id); err != nil {
		return err
	}
	// S2: gleicher Grund wie bei Create() — ein extern gelöschter
	// Workflow soll auch in anderen offenen Tabs sofort verschwinden.
	// Der Payload trägt den letzten bekannten Stand vor dem Löschen; die
	// UI liest ihn ohnehin nicht, sondern lädt bei Empfang die komplette
	// (jetzt schon aktualisierte) Liste neu.
	s.publish(wf)
	return nil
}

// exportVersion ist das Versionsfeld von ExportedWorkflow — bei einer
// künftigen inkompatiblen Formatänderung hochzuzählen, damit Import()
// eine verständliche Ablehnung statt eines stillen Fehlinterpretierens
// liefern kann (heute noch keine Versionsprüfung nötig, es gibt nur
// Version 1).
const exportVersion = 1

// Export liefert den Datei-Inhalt für GET /api/v1/workflows/{id}/export
// (Kapitel 12 Teil 3, §12.3d) — in jedem Zustand abrufbar (auch
// laufend: der Export beschreibt die Definition, nicht den
// Laufzeitzustand).
func (s *Service) Export(id string) (ExportedWorkflow, error) {
	wf, err := s.store.Get(id)
	if err != nil {
		return ExportedWorkflow{}, err
	}
	return ExportedWorkflow{Version: exportVersion, Name: wf.Name, Definition: wf.Definition}, nil
}

// Import legt aus einer zuvor per Export() erzeugten Datei einen neuen,
// gestoppten Workflow an (§12.3d). Validiert jede Rolle gegen den
// Katalog — ein unbekannter nodeType ergibt eine verständliche
// Ablehnung statt eines Import-Torsos (Definition wörtlich). Eine
// Namenskollision bekommt einen Suffix statt den Import abzulehnen
// ("Suffix oder Fehler" — Suffix gewählt: ein Import soll nicht daran
// scheitern, dass zufällig schon ein gleichnamiger Workflow existiert).
func (s *Service) Import(exported ExportedWorkflow) (Workflow, error) {
	known := map[string]bool{}
	for _, entry := range s.launcher.Catalog() {
		known[entry.Type] = true
	}
	for _, role := range exported.Definition.Roles {
		if !known[role.NodeType] {
			return Workflow{}, fmt.Errorf("%w: role %q references unknown node type %q (not in catalog)", ErrValidation, role.Name, role.NodeType)
		}
	}

	existing, err := s.store.List()
	if err != nil {
		return Workflow{}, err
	}
	name := uniqueWorkflowName(exported.Name, existing)

	return s.Create(name, exported.Definition)
}

func uniqueWorkflowName(name string, existing []Workflow) string {
	used := map[string]bool{}
	for _, wf := range existing {
		used[wf.Name] = true
	}
	if !used[name] {
		return name
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s (%d)", name, i)
		if !used[candidate] {
			return candidate
		}
	}
}

// Update überschreibt Name und Definition eines Workflows — nur in
// "stopped"/"paused" (§22.3 Punkt 2 / Kapitel 12 Teil 1,
// docs/END-GOAL-FEATURES.md §12.3c: "PUT /api/v1/workflows/{id} …
// §22.3 Punkt 2 einlösen"; Teil 3 §12.3c erweitert das ausdrücklich um
// "paused"). Gleiche Begründung wie bei Delete: kein Umschreiben der
// Definition unter noch laufenden Prozessen, die die alte Definition
// ausführen.
func (s *Service) Update(id, name string, def Definition) (Workflow, error) {
	if err := validate(def); err != nil {
		return Workflow{}, err
	}
	wf, err := s.store.Get(id)
	if err != nil {
		return Workflow{}, err
	}
	if wf.Status != StatusStopped && wf.Status != StatusPaused {
		return Workflow{}, ErrNotStopped
	}
	wf.Name = name
	wf.Definition = def
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		return Workflow{}, err
	}
	s.publish(wf)
	return wf, nil
}

// Start provisioniert alle Rollen eines Workflows (lokal oder remote,
// s. Launcher) und verkabelt sie gemäß Verbindungs-Template, sobald sie
// in der NMOS-Registry erscheinen. Läuft im Hintergrund weiter, nachdem
// Start() zurückkehrt — der Aufrufer sieht sofort den Zwischenzustand
// "starting" und kann per GET /api/v1/workflows/{id} (oder SSE) den
// weiteren Fortschritt beobachten. Das hält den HTTP-Handler kurz, auch
// wenn reale GStreamer-Pipelines mehrere Sekunden zum Hochfahren
// brauchen.
//
// Aus "paused" aufgerufen ist das gleichbedeutend mit "Resume" (Kapitel
// 12 Teil 3, §12.3c: "Resume = normaler Start, inkl. D7-Teil-2-
// Vorprüfung") — kein eigener Resume()-Pfad nötig, da Pause() dieselben
// Prozesse wie Stop() beendet (s. Pause-Doku) und ein Neustart daher
// ohnehin identisch zu einem regulären Start abläuft.
func (s *Service) Start(ctx context.Context, id string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStopped && wf.Status != StatusFailed && wf.Status != StatusPaused {
		return ErrNotStopped
	}
	if err := s.checkResources(wf); err != nil {
		return err
	}

	wf.Status = StatusStarting
	wf.Error = ""
	wf.Runtime = map[string]RoleRuntime{}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		return err
	}
	s.publish(wf)

	go s.runStart(wf)
	return nil
}

// persistSchedule schreibt die LastFiredAt-Markierungen des Schedulers
// über Store.UpdateSchedules — bewusst **kein** Get()+Put() des ganzen
// Workflows: runStart/runStop/rewireAfterRestart laufen als
// Hintergrund-Goroutinen und schreiben über mehrere Sekunden hinweg
// wiederholt den *gesamten*, zu ihrem eigenen Start erfassten wf-Stand
// zurück — ein zwischenzeitliches Get()+Put() hier würde von einem
// SPÄTEREN dieser Blind-Overwrite-Puts wieder verworfen (live gefunden
// 2026-07-18, docs/decisions.md: ein "once"-Schedule feuerte dadurch
// dreimal). UpdateSchedules ändert nur den definition.schedules-Pfad im
// JSONB-Blob und kollidiert daher nie mit einem parallelen Put(), das
// status/runtime/error schreibt.
func (s *Service) persistSchedule(wf Workflow) error {
	if err := s.store.UpdateSchedules(wf.ID, wf.Definition.Schedules); err != nil {
		return err
	}
	current, err := s.store.Get(wf.ID)
	if err != nil {
		return err
	}
	s.publish(current)
	return nil
}

// checkResources ist die Ressourcen-Vorprüfung als harte Start-
// Vorbedingung (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 3): bevor
// irgendetwas provisioniert wird, muss für JEDE Rolle mit gesetzter
// HostID (Remote-Platzierung, s. Role-Doku) feststehen, dass der
// Ziel-Host aktuell nicht überlastet ist — kein Teil-Start, der mangels
// Ressourcen auf halbem Weg hängen bleibt. Lokale Rollen (HostID leer)
// sind nicht Teil der Prüfung: der Orchestrator hat für "den lokalen
// Host" selbst keine Telemetrie (nur registrierte Remote-Hosts senden
// welche, s. internal/hosts) — dokumentierte Folgearbeit, kein stiller
// Blocker ohne Datengrundlage.
//
// Seit Kapitel 14 Teil 4 wird **jede** Rolle einzeln geprüft (vor Teil 4
// genügte ein Check pro HostID, weil nur der host-weite Momentwert
// zählte) — CheckHost projiziert jetzt zusätzlich das Verbrauchsprofil
// von role.NodeType, zwei Rollen desselben Typs auf demselben Host
// hätten sonst nur einmal gezählt. Bewusst vereinfacht: mehrere
// verschiedene Rollen auf demselben Host werden gegen dieselbe,
// unveränderte Host-Momentmessung geprüft (kein kumulatives
// "alle Rollen zusammen simulieren") — konsistent mit dem advisory-
// artigen, best-effort Charakter dieser gesamten Vorprüfung.
func (s *Service) checkResources(wf Workflow) error {
	if s.resources == nil {
		return nil
	}
	for _, role := range wf.Definition.Roles {
		if role.HostID == "" {
			continue
		}
		if reason, ok := s.resources.CheckHost(role.HostID, role.NodeType); !ok {
			return fmt.Errorf("%w: host %s: %s", ErrResourcesUnavailable, role.HostID, reason)
		}
	}
	return nil
}

// runStart führt die eigentliche Provisionierung aus (Hintergrund-
// Goroutine, s. Start()). Fehler bei einzelnen Rollen werden gesammelt
// statt beim ersten Fehler abzubrechen (gleiches Muster wie
// snapshots.Service.Apply) — der Workflow landet dann in "failed" mit
// einer verständlichen Fehlermeldung, bereits gestartete Rollen bleiben
// **absichtlich laufen** (kein automatisches Rollback: ein Teil-Start ist
// im Zweifel nützlicher als ein sofortiger Stopp mitten in der
// Provisionierung, und die Rollen sind über den Workflow jederzeit per
// Stop() gebündelt wieder zu beenden). Volle Ressourcen-Vorprüfung, die
// einen Teil-Start von vornherein verhindert, ist §6.2s "harte
// Vorbedingung" — braucht die noch zurückgestellte Placement-Engine
// (§6.1), dokumentierte Folgearbeit, nicht Teil 1.
func (s *Service) runStart(wf Workflow) {
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	defer cancel()

	// Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c): Workflow-Settings
	// wie die Programm-Auflösung wandern als extraEnv in jeden lokalen
	// Rollen-Start (s. launcher.Launcher.Start-Doku zur Remote-
	// Einschränkung). 0 = nicht gesetzt, Node behält ihren eigenen
	// Default — kein OMP_WIDTH/OMP_HEIGHT für Workflows ohne Settings.
	extraEnv := map[string]string{}
	if wf.Definition.Settings.ProgramWidth > 0 {
		extraEnv["OMP_WIDTH"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramWidth), 10)
	}
	if wf.Definition.Settings.ProgramHeight > 0 {
		extraEnv["OMP_HEIGHT"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramHeight), 10)
	}

	pending := map[string]string{} // roleName -> instanceID, noch nicht in der Registry gesehen
	for _, role := range wf.Definition.Roles {
		inst, err := s.launcher.Start(role.NodeType, "", role.HostID, extraEnv)
		if err != nil {
			s.fail(wf, fmt.Sprintf("role %s: start failed: %v", role.Name, err))
			return
		}
		wf.Runtime[role.Name] = RoleRuntime{InstanceID: inst.ID}
		pending[role.Name] = inst.ID
	}
	// Zwischenstand best effort persistieren (Runtime-Instanz-IDs sichtbar,
	// während awaitRegistration unten noch läuft) — der Endzustand wird in
	// jedem Fall weiter unten nochmal geschrieben, ein Fehler hier ist
	// daher nicht fatal.
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: failed to persist intermediate state", "id", wf.ID, "error", err)
	}

	if err := s.awaitRegistration(ctx, wf, pending); err != nil {
		s.fail(wf, err.Error())
		return
	}

	for _, conn := range wf.Definition.Connections {
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			s.fail(wf, fmt.Sprintf("connection %s -> %s: role %s not registered", conn.FromRole, conn.ToRole, conn.FromRole))
			return
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			s.fail(wf, fmt.Sprintf("connection %s -> %s: role %s not registered", conn.FromRole, conn.ToRole, conn.ToRole))
			return
		}
		if err := s.applyConnection(ctx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole)); err != nil {
			s.fail(wf, err.Error())
			return
		}
	}

	wf.Status = StatusStarted
	wf.Error = ""
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: failed to persist started state", "id", wf.ID, "error", err)
	}
	s.publish(wf)

	// Kapitel 12 Teil 6 (§22.3 Punkt 5: "optional automatisch bei jedem
	// start, sobald die Program-Bus-Rolle 'media-ready' meldet") — ein
	// eigener dediziertes Bereitschafts-Event existiert dafür nicht (kein
	// Node meldet "media-ready" heute), pragmatischer Ersatz: sofort nach
	// erfolgreicher Verkabelung versuchen, mit kurzem, in
	// captureWorkflowThumbnail gebundenem Timeout (der Preview-Broadcaster
	// liefert ohnehin erst das erste tatsächlich produzierte Frame, s.
	// omp-mediaio::preview::serve_client — kein Rennen gegen eine noch
	// nicht laufende Pipeline). Eigene Goroutine: runStart() selbst läuft
	// bereits im Hintergrund, soll aber nicht durch einen langsamen/
	// hängenden Preview-Endpunkt zusätzlich verzögert bleiben, bevor der
	// nächste Start-Aufruf dieselbe Rolle erneut provisionieren könnte.
	go s.captureWorkflowThumbnail(wf)
}

// awaitRegistration pollt den Node-Bestand, bis für jede Rolle ein Node
// mit passender InstanceID erscheint, und trägt dessen Node-ID in
// wf.Runtime ein.
func (s *Service) awaitRegistration(ctx context.Context, wf Workflow, pending map[string]string) error {
	ticker := time.NewTicker(registrationPollInterval)
	defer ticker.Stop()

	for {
		for role, instanceID := range pending {
			if node, ok := findByInstanceID(s.nodes.List(), instanceID); ok {
				rt := wf.Runtime[role]
				rt.NodeID = node.ID
				wf.Runtime[role] = rt
				delete(pending, role)
			}
		}
		if len(pending) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			missing := make([]string, 0, len(pending))
			for role := range pending {
				missing = append(missing, role)
			}
			return fmt.Errorf("timed out waiting for registration of role(s): %v", missing)
		case <-ticker.C:
		}
	}
}

// awaitFreshRegistration wartet auf eine Registrierung von instanceID,
// deren Node-ID sich von excludeNodeID unterscheidet — anders als
// awaitRegistration (das für den Workflow-Start passt: dort existiert
// vorher garantiert keine Registrierung) für den Neustart-Fall
// (rewireAfterRestart), wo die alte Registrierung des per SIGKILL
// beendeten Prozesses noch bis zu ihrem Heartbeat-Timeout sichtbar sein
// kann, während der neu gestartete Prozess sich bereits unter einer
// neuen Node-ID anmeldet. excludeNodeID darf leer sein (Rolle hatte
// noch keine aufgelöste Node-ID) — dann zählt jede Registrierung.
func (s *Service) awaitFreshRegistration(ctx context.Context, instanceID, excludeNodeID string) (registry.NodeView, error) {
	ticker := time.NewTicker(registrationPollInterval)
	defer ticker.Stop()

	for {
		// Bewusst nicht findByInstanceID (das liefert nur den *ersten*
		// Treffer zurück): solange die alte Registrierung noch nicht
		// abgelaufen ist, stünde die für immer an erster Stelle und
		// awaitFreshRegistration würde nie über sie hinauskommen — hier
		// muss über *alle* Knoten mit passender InstanceID gesucht
		// werden, bis einer mit einer anderen ID als excludeNodeID dabei
		// ist.
		for _, n := range s.nodes.List() {
			if n.InstanceID == instanceID && n.ID != excludeNodeID {
				return n, nil
			}
		}
		select {
		case <-ctx.Done():
			return registry.NodeView{}, fmt.Errorf("timed out waiting for fresh registration of instance %s", instanceID)
		case <-ticker.C:
		}
	}
}

// InstanceRestarted implementiert launcher.RestartObserver (K7-Teil-1,
// docs/END-GOAL-FEATURES.md §7.3a/§7.6): der Launcher ruft dies auf,
// sobald er eine abgestürzte Instanz automatisch in derselben Instanz-ID
// neu gestartet hat. Generalisiert den bisher nur an Start() gebundenen
// node.added-Glue (runStart oben) auf "eine erwartete Rolle eines
// laufenden Workflows ist nach einem Neustart wieder da": wartet erneut
// auf ihre Registrierung und wendet alle Connections neu an, die diese
// Rolle betreffen. Läuft im Hintergrund — der Launcher darf auf diesen
// Aufruf nicht warten müssen.
func (s *Service) InstanceRestarted(instanceID string) {
	go s.rewireAfterRestart(instanceID)
}

func (s *Service) rewireAfterRestart(instanceID string) {
	wfs, err := s.store.List()
	if err != nil {
		slog.Warn("workflows: rewireAfterRestart: list failed", "error", err)
		return
	}
	var workflowID, role string
	for _, wf := range wfs {
		if wf.Status != StatusStarted {
			continue
		}
		for r, rt := range wf.Runtime {
			if rt.InstanceID == instanceID {
				workflowID, role = wf.ID, r
				break
			}
		}
		if workflowID != "" {
			break
		}
	}
	if workflowID == "" {
		// Instanz gehört zu keinem laufenden Workflow (z. B. ein direkt
		// über den Katalog gestarteter Node) — nichts zu verkabeln, der
		// Launcher-eigene Neustart genügt.
		return
	}

	// Frisch laden statt der List()-Kopie weiterzuverwenden: zwischen dem
	// Auffinden oben und hier könnte der Workflow bereits gestoppt worden
	// sein.
	wf, err := s.store.Get(workflowID)
	if err != nil || wf.Status != StatusStarted {
		return
	}

	// Nicht awaitRegistration (das nimmt jede Registrierung mit
	// passender InstanceID, auch eine schon vor dem Absturz bestehende)
	// — ein per SIGKILL beendeter Prozess bekommt keine Chance, sich
	// selbst abzumelden, seine alte NMOS-Registrierung kann also noch
	// eine ganze Weile (Heartbeat-Timeout) neben der neuen sichtbar
	// bleiben. awaitFreshRegistration wartet gezielt auf eine Node-ID,
	// die sich von der zuletzt bekannten unterscheidet — live per
	// kill -9 verifiziert: ohne diese Unterscheidung blieb die
	// Verbindung auf den (kurz danach verschwindenden) toten Sender der
	// alten Registrierung stehen, statt auf den neuen umzuschwenken.
	previousNodeID := wf.Runtime[role].NodeID
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	node, err := s.awaitFreshRegistration(ctx, instanceID, previousNodeID)
	cancel()
	if err != nil {
		slog.Warn("workflows: rewireAfterRestart: registration timed out", "workflow", wf.ID, "role", role, "error", err)
		return
	}
	rt := wf.Runtime[role]
	rt.NodeID = node.ID
	wf.Runtime[role] = rt

	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != role && conn.ToRole != role {
			continue
		}
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			slog.Warn("workflows: rewireAfterRestart: sender role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			slog.Warn("workflows: rewireAfterRestart: receiver role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout)
		err := s.applyConnection(connectCtx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		connectCancel()
		if err != nil {
			slog.Warn("workflows: rewireAfterRestart: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}

	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: rewireAfterRestart: persist failed", "workflow", wf.ID, "error", err)
	}
	s.publish(wf)
	slog.Info("workflows: rewired role after automatic restart", "workflow", wf.ID, "role", role, "instance", instanceID)
}

// waitForCrosspointInput pollt param auf dem Zielnode, bis senderID
// unter dessen automatisch entdeckten Eingängen erscheint — s.
// crosspointMethod-Doku oben zum Grund. Gleiches Poll-Muster wie
// awaitRegistration (registrationPollInterval), gebunden an den vom
// Aufrufer übergebenen ctx (in runStart/rewireAfterRestart bereits mit
// registrationTimeout budgetiert).
func (s *Service) waitForCrosspointInput(ctx context.Context, baseURL, param, senderID string) error {
	ticker := time.NewTicker(registrationPollInterval)
	defer ticker.Stop()

	for {
		if raw, err := s.methods.GetParam(ctx, baseURL, param); err == nil {
			var inputs []struct {
				SenderID string `json:"senderId"`
			}
			if json.Unmarshal(raw, &inputs) == nil {
				for _, in := range inputs {
					if in.SenderID == senderID {
						return nil
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for sender %s to appear in %s/params/%s", senderID, baseURL, param)
		case <-ticker.C:
		}
	}
}

// applyConnection löst eine einzelne Workflow-Connection auf: ein echter
// IS-05 Connect, falls die Zielrolle einen IS-04-Receiver hat (Standard-
// fall, z. B. omp-viewer); sonst ein Crosspoint-Methodenaufruf, falls der
// Zielrollen-Node-Typ in crosspointByNodeType bekannt ist (s.
// Connection-Doku in types.go); sonst ein verständlicher Fehler statt
// eines stillen No-Op.
func (s *Service) applyConnection(ctx context.Context, conn Connection, fromNode, toNode registry.NodeView, toRoleNodeType string) error {
	sender, ok := findSender(fromNode, conn.FromSender)
	if !ok {
		return fmt.Errorf("connection %s -> %s: role %s has no sender%s", conn.FromRole, conn.ToRole, conn.FromRole, labelSuffix(conn.FromSender))
	}

	if len(toNode.Receivers) > 0 {
		receiver, ok := findReceiver(toNode, conn.ToReceiver)
		if !ok {
			return fmt.Errorf("connection %s -> %s: role %s has no receiver%s", conn.FromRole, conn.ToRole, conn.ToRole, labelSuffix(conn.ToReceiver))
		}
		return s.graph.Connect(ctx, sender.ID, receiver.ID)
	}

	if cp, ok := crosspointByNodeType[toRoleNodeType]; ok {
		if toNode.APIBaseURL == "" {
			return fmt.Errorf("connection %s -> %s: role %s has no reachable api endpoint", conn.FromRole, conn.ToRole, conn.ToRole)
		}
		if err := s.waitForCrosspointInput(ctx, toNode.APIBaseURL, cp.InputsParam, sender.ID); err != nil {
			return fmt.Errorf("connection %s -> %s: %w", conn.FromRole, conn.ToRole, err)
		}
		return s.methods.Invoke(ctx, toNode.APIBaseURL, cp.Method, map[string]any{cp.Arg: sender.ID})
	}

	return fmt.Errorf("connection %s -> %s: role %s (%s) has neither a receiver nor a known crosspoint method", conn.FromRole, conn.ToRole, conn.ToRole, toRoleNodeType)
}

// findSender wählt den Sender eines Nodes nach Label — leeres label
// bedeutet den bisherigen Kompatibilitäts-Fallback (erster Sender).
func findSender(node registry.NodeView, label string) (registry.SenderView, bool) {
	if label == "" {
		if len(node.Senders) == 0 {
			return registry.SenderView{}, false
		}
		return node.Senders[0], true
	}
	for _, sndr := range node.Senders {
		if sndr.Label == label {
			return sndr, true
		}
	}
	return registry.SenderView{}, false
}

// findReceiver wählt den Receiver eines Nodes nach Label — analog
// findSender.
func findReceiver(node registry.NodeView, label string) (registry.ReceiverView, bool) {
	if label == "" {
		if len(node.Receivers) == 0 {
			return registry.ReceiverView{}, false
		}
		return node.Receivers[0], true
	}
	for _, r := range node.Receivers {
		if r.Label == label {
			return r, true
		}
	}
	return registry.ReceiverView{}, false
}

func labelSuffix(label string) string {
	if label == "" {
		return ""
	}
	return fmt.Sprintf(" labeled %q", label)
}

// roleNodeType liefert den Node-Typ einer Rolle aus der Workflow-
// Definition (statisch bekannt, unabhängig vom Laufzeitzustand).
func roleNodeType(wf Workflow, roleName string) string {
	for _, r := range wf.Definition.Roles {
		if r.Name == roleName {
			return r.NodeType
		}
	}
	return ""
}

func (s *Service) nodeForRole(wf Workflow, role string) (registry.NodeView, bool) {
	rt, ok := wf.Runtime[role]
	if !ok || rt.NodeID == "" {
		return registry.NodeView{}, false
	}
	for _, n := range s.nodes.List() {
		if n.ID == rt.NodeID {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (s *Service) fail(wf Workflow, reason string) {
	wf.Status = StatusFailed
	wf.Error = reason
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: failed to persist failed state", "id", wf.ID, "error", err)
	}
	slog.Warn("workflows: start failed", "id", wf.ID, "reason", reason)
	s.publish(wf)
}

// Stop beendet alle laufenden Rollen-Instanzen eines Workflows — auch
// aus dem Zustand "failed" heraus aufrufbar (ein teilgestarteter
// Workflow muss trotzdem gebündelt aufräumbar sein). Fehler beim Stoppen
// einzelner Rollen werden gesammelt, nicht abgebrochen (best effort,
// gleiches Muster wie beim Start).
//
// confirm ist die Stop-Sicherheitsabfrage (D7 Teil 2, ARCHITECTURE.md
// §6.2 Punkt 2): ist Definition.Settings.ConfirmStop gesetzt, verlangt
// Stop() confirm=true, sonst ErrConfirmationRequired (zweistufig — der
// Aufrufer/die UI zeigt dann eine Rückfrage und ruft mit confirm=true
// erneut auf). Ein zeitgesteuerter Stop (scheduler.go) ruft immer mit
// confirm=true auf — die Bestätigung ist beim Anlegen des Zeitplans
// bereits erfolgt.
func (s *Service) Stop(ctx context.Context, id string, confirm bool) error {
	return s.stopOrPause(ctx, id, confirm, StatusStopped)
}

// Pause beendet alle laufenden Rollen-Instanzen eines Workflows — exakt
// wie Stop() (Kapitel 12 Teil 3, §12.3c, wörtlich: "technisch stoppt
// pause dieselben Prozesse wie stop — der Unterschied ist Sichtbarkeit
// und Absicht"), landet aber in "paused" statt "stopped". Der Editor
// rendert einen pausierten Workflow weiterhin als benannten Rahmen mit
// Platzhalter-Kacheln (ui/graph/flow-canvas.ts), ein gestoppter
// verschwindet von der Canvas. confirm_stop gilt identisch (gleiche
// Ressourcen-Wirkung wie Stop, gleiche Rückfrage-Notwendigkeit).
func (s *Service) Pause(ctx context.Context, id string, confirm bool) error {
	return s.stopOrPause(ctx, id, confirm, StatusPaused)
}

func (s *Service) stopOrPause(ctx context.Context, id string, confirm bool, targetStatus string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted && wf.Status != StatusFailed && wf.Status != StatusStarting {
		return ErrNotRunning
	}
	if wf.Definition.Settings.ConfirmStop && !confirm {
		return ErrConfirmationRequired
	}

	wf.Status = StatusStopping
	if targetStatus == StatusPaused {
		wf.Status = StatusPausing
	}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		return err
	}
	s.publish(wf)

	go s.runStop(wf, targetStatus)
	return nil
}

func (s *Service) runStop(wf Workflow, targetStatus string) {
	var errs []string
	for role, rt := range wf.Runtime {
		if rt.InstanceID == "" {
			continue
		}
		if err := s.launcher.Stop(rt.InstanceID); err != nil {
			errs = append(errs, fmt.Sprintf("role %s: %v", role, err))
		}
	}

	wf.Runtime = map[string]RoleRuntime{}
	if len(errs) > 0 {
		wf.Status = StatusFailed
		wf.Error = fmt.Sprintf("stop finished with errors: %v", errs)
	} else {
		wf.Status = targetStatus
		wf.Error = ""
	}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: failed to persist stopped state", "id", wf.ID, "error", err)
	}
	s.publish(wf)
}

func (s *Service) publish(wf Workflow) {
	if s.events == nil {
		return
	}
	data, err := json.Marshal(wf)
	if err != nil {
		return
	}
	s.events.Broadcast(sse.Event{Type: "workflow.updated", Data: data})
}

func findByInstanceID(nodes []registry.NodeView, instanceID string) (registry.NodeView, bool) {
	for _, n := range nodes {
		if n.InstanceID == instanceID {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func validate(def Definition) error {
	if len(def.Roles) == 0 {
		return fmt.Errorf("%w: at least one role required", ErrValidation)
	}
	nodeTypeByRole := map[string]string{}
	for _, r := range def.Roles {
		if r.Name == "" || r.NodeType == "" {
			return fmt.Errorf("%w: role name and nodeType required", ErrValidation)
		}
		if _, ok := nodeTypeByRole[r.Name]; ok {
			return fmt.Errorf("%w: duplicate role name %q", ErrValidation, r.Name)
		}
		nodeTypeByRole[r.Name] = r.NodeType
	}
	// Crosspoint-Zielrollen (s. Connection-Doku in types.go) haben genau
	// einen aktiven Eingang — mehr als eine eingehende Connection wäre
	// eine unauflösbare Mehrdeutigkeit ("welcher Sender gewinnt beim
	// Start?"), anders als bei Receiver-Zielen, wo mehrere Connections
	// auf verschiedene Receiver-Labels durchaus gültig sind.
	crosspointTargets := map[string]bool{}
	for _, c := range def.Connections {
		if _, ok := nodeTypeByRole[c.FromRole]; !ok {
			return fmt.Errorf("%w: connection references unknown role %q", ErrValidation, c.FromRole)
		}
		if _, ok := nodeTypeByRole[c.ToRole]; !ok {
			return fmt.Errorf("%w: connection references unknown role %q", ErrValidation, c.ToRole)
		}
		if _, ok := crosspointByNodeType[nodeTypeByRole[c.ToRole]]; ok {
			if crosspointTargets[c.ToRole] {
				return fmt.Errorf("%w: role %q accepts at most one incoming connection (crosspoint target)", ErrValidation, c.ToRole)
			}
			crosspointTargets[c.ToRole] = true
		}
	}
	for _, sched := range def.Schedules {
		if err := validateSchedule(sched); err != nil {
			return err
		}
	}
	return nil
}

// validateSchedule prüft einen einzelnen Zeitplan-Eintrag (D7 Teil 2) —
// je nach Kind sind unterschiedliche Felder Pflicht (s. Schedule-Doku in
// types.go).
func validateSchedule(sched Schedule) error {
	switch sched.Action {
	case ScheduleActionStart, ScheduleActionStop:
	default:
		return fmt.Errorf("%w: schedule action must be %q or %q", ErrValidation, ScheduleActionStart, ScheduleActionStop)
	}
	switch sched.Kind {
	case ScheduleOnce:
		if sched.At == nil {
			return fmt.Errorf("%w: schedule kind %q requires \"at\"", ErrValidation, ScheduleOnce)
		}
	case ScheduleDaily:
		if _, _, ok := parseTimeOfDay(sched.TimeOfDay); !ok {
			return fmt.Errorf("%w: schedule kind %q requires timeOfDay \"HH:MM\"", ErrValidation, ScheduleDaily)
		}
	case ScheduleWeekly:
		if _, _, ok := parseTimeOfDay(sched.TimeOfDay); !ok {
			return fmt.Errorf("%w: schedule kind %q requires timeOfDay \"HH:MM\"", ErrValidation, ScheduleWeekly)
		}
		if sched.Weekday == nil || *sched.Weekday < 0 || *sched.Weekday > 6 {
			return fmt.Errorf("%w: schedule kind %q requires weekday 0-6", ErrValidation, ScheduleWeekly)
		}
	default:
		return fmt.Errorf("%w: unknown schedule kind %q", ErrValidation, sched.Kind)
	}
	return nil
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

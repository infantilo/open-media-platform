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
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
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

// controlPlaneNodeTypes sind Node-Typen, die als Automatisations-/
// Control-Plane-Instanz eines Workflows gelten und deshalb bei
// Workflow-Start automatisch eine Workflow-gescopte VerbOperate-
// Rollenbindung bekommen (ARCHITECTURE.md §24.1, UMSETZUNG.md C16) —
// diese Instanz kann sich damit anschließend über
// `POST /api/v1/instances/<id>/service-token` (ihr eigenes
// OMP_LAUNCH_SECRET als Nachweis) ein Bearer-Token holen und den
// generischen Proxy statt eines direkten Node-zu-Node-Zugriffs
// ansprechen. Eine von Hand gepflegte Liste statt eines Katalog-
// `category`-Felds (§13.5 ist bisher nur ARCHITECTURE.md-Beschreibung,
// `launcher.CatalogEntry` hat dieses Feld noch nicht) — gleiches
// Konventions-Muster wie `crosspointByNodeType` oben, direkt aus dem
// tatsächlichen Node-Quelltext übernommen (nicht geraten, UMSETZUNG.md
// §0 Punkt 6): `nodes/omp-playout-automation` ist heute der einzige
// reine Control-Plane-Node, der andere Nodes fernsteuert.
var controlPlaneNodeTypes = map[string]bool{
	"omp-playout-automation": true,
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
	// StartLabeled ist Start mit optionalem customLabel (Nutzerwunsch
	// 2026-07-28) — s. dortige Doku. Genutzt hier, um jede Rolle mit
	// ihrem Rollennamen statt einem generischen "<Typ> (<Kurz-ID>)"-Label
	// zu starten, damit Quellen in Kreuzschienen-Dropdowns (Bild-/
	// Audiomischer) sinnvoll benannt sind.
	StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error)
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

// AuthzBinder legt Rollenbindungen an (implementiert von *authz.Store,
// ARCHITECTURE.md §24.1, UMSETZUNG.md C16) — Workflow-Start nutzt dies,
// um jeder Control-Plane-Instanz (s. controlPlaneNodeTypes) automatisch
// eine Workflow-gescopte VerbOperate-Bindung zu geben. Darf nil sein
// (z. B. bestehende Tests, die AuthZ nicht prüfen) — dann bleibt das
// Provisionieren ersatzlos aus, gleiches Muster wie
// `resources ResourcePrecheck`.
type AuthzBinder interface {
	Create(subject, workflowID, nodeID string, verb authz.Verb) (authz.Binding, error)
	// LoadByWorkflow/DeleteByWorkflow (Nutzerwunsch 2026-07-28): Export
	// kann Workflow-gescopte Bindungen optional mitexportieren (s.
	// Export-Doku), Delete räumt sie beim endgültigen Löschen eines
	// Workflows verwaisungsfrei mit auf.
	LoadByWorkflow(workflowID string) ([]authz.Binding, error)
	DeleteByWorkflow(workflowID string) error
}

type workflowStore interface {
	Put(wf Workflow) error
	Get(id string) (Workflow, error)
	List() ([]Workflow, error)
	Delete(id string) error
	UpdateSchedules(id string, schedules []Schedule) error
	UpdateRuntime(wf Workflow) error
	// SetRoleState/GetRoleState (Bugfix 2026-07-26, Migration 0011).
	SetRoleState(id, role string, state json.RawMessage) error
	GetRoleState(id string) (map[string]json.RawMessage, error)
	// ClearRoleState (Bugfix 2026-07-26, s. Update()): ein Definitions-
	// Wechsel invalidiert zuvor erfasste Rollen-Zustände.
	ClearRoleState(id string) error
}

// ResourcePrecheck ist die von *placement.Engine implementierte
// Teilmenge, die workflows.Service für die Host-Platzierung braucht.
// Bewusst als Interface gehalten (nicht *placement.Engine direkt), damit
// service_test.go ohne eine echte Engine (Postgres-Profile-Store etc.)
// auskommt — gleiches Muster wie NodeLister/Launcher/EventPublisher.
type ResourcePrecheck interface {
	// CheckHost liefert (Ablehnungsgrund, ok) für den Start von nodeType
	// auf hostID. ok=true bei freien Ressourcen ODER fehlender Telemetrie
	// (fail-open — ein gerade erst registrierter Host ohne Messwerte ist
	// kein Blocker, gleiche Haltung wie placement.Engine.evaluateOnce bei
	// fehlenden Daten). Seit Kapitel 14 Teil 4 rechnet die Prüfung mit dem
	// Verbrauchsprofil von nodeType (falls bekannt), nicht mehr nur mit
	// dem aktuellen Momentwert des Hosts (docs/END-GOAL-FEATURES.md
	// §14.4 Teil 4). Bleibt öffentlich (u. a. von httpapi genutzt für
	// Diagnose-Zwecke), auch wenn runStart selbst seit Nachtrag 99
	// SelectHost statt CheckHost direkt aufruft.
	CheckHost(hostID, nodeType string) (reason string, ok bool)
	// SelectHost (Nachtrag 99, ARCHITECTURE.md §6.1/§16-Erweiterung)
	// wählt den tatsächlichen Zielhost für EINE Rolle eines
	// Workflow-Starts — ersetzt die vormals harte checkResources-
	// Vorbedingung: der Start soll immer gelingen, s. runStart.
	SelectHost(req placement.PlacementRequest, occ placement.Occupancy) placement.PlacementResult
	// ProjectedLoad liefert das erwartete Verbrauchsprofil von nodeType
	// auf hostID (host-spezifisch oder Typ-Fallback) — von
	// buildOccupancy genutzt, um die Forecast-Zusatzlast bald fälliger
	// Starts ANDERER Workflows zu schätzen (Nachtrag 99), ohne dass
	// workflows selbst eine profiles.Store-Abhängigkeit bräuchte.
	ProjectedLoad(nodeType, hostID string) profiles.Snapshot
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
	// httpClient: derselbe ggf. mTLS-fähige Client wie methods, hier
	// zusätzlich direkt gehalten, weil state.go (getNodeState/
	// postNodeState) den rohen JSON-Body des Node-eigenen /state-
	// Endpunkts liest/schreibt (methodInvoker kennt nur das
	// {"value": ...}-Parameter-Format).
	httpClient *http.Client
	// authz (ARCHITECTURE.md §24.1, UMSETZUNG.md C16) — s. AuthzBinder.
	authz AuthzBinder
	// hostMetrics (K7 Teil 4, failover.go) — s. SetHostMetrics/
	// HostMetricsReader. Nil = Host-Offline-Failover-Trigger bleibt aus
	// (kein Crash, nur ein fehlendes Feature ohne Verdrahtung, gleiches
	// Nil-Safety-Muster wie resources ResourcePrecheck).
	hostMetrics HostMetricsReader
	// migrations (D6 Teil 4, migration.go) — Buchführung für
	// auto-confirm-window-Timer und laufende Migrationsversuche. Immer
	// initialisiert (nie nil, s. NewService), damit migration.go ohne
	// Nil-Checks auskommt — anders als resources/authzBinder/hostMetrics
	// ist das keine optionale externe Abhängigkeit, sondern rein
	// interner Zustand.
	migrations *migrationState
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
// authzBinder darf ebenso nil sein (gleiches Nil-Safety-Muster) — dann
// bekommen Control-Plane-Instanzen keine automatische Rollenbindung
// (ARCHITECTURE.md §24.1).
func NewService(store *Store, nodes NodeLister, graphSvc GraphService, l Launcher, events EventPublisher, httpClient *http.Client, resources ResourcePrecheck, authzBinder AuthzBinder) *Service {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Service{store: store, nodes: nodes, graph: graphSvc, launcher: l, events: events, methods: newHTTPMethodInvoker(httpClient), resources: resources, httpClient: httpClient, authz: authzBinder, migrations: newMigrationState()}
}

// Create legt einen neuen Workflow an — gestoppt, es sei denn adopt ist
// gesetzt. adopt (Nutzerwunsch, Kapitel 12 Teil 2 Ergänzung: "Als
// Workflow speichern" aus einer bereits laufenden Gruppe soll den
// Workflow nicht als "stopped" anzeigen, wenn seine Rollen tatsächlich
// schon laufen) ordnet Rollennamen bereits laufenden, registrierten
// Instanzen zu — deckt es ALLE Rollen der Definition ab, startet der
// Workflow direkt im Status "started" mit genau dieser Runtime-Zuordnung,
// ohne den normalen Launcher-Start-Pfad (runStart) zu durchlaufen (die
// Instanzen laufen ja bereits). Eine nur TEILWEISE abgedeckte oder eine
// unbekannte Rollen referenzierende Zuordnung wird abgelehnt
// (ErrValidation) statt einen Workflow in einem widersprüchlichen
// Zwischenzustand anzulegen — leer/nil bedeutet unverändertes
// Alt-Verhalten (immer "stopped", keine Runtime).
func (s *Service) Create(name string, def Definition, adopt map[string]RoleRuntime) (Workflow, error) {
	if err := validate(def); err != nil {
		return Workflow{}, err
	}
	if len(adopt) > 0 {
		roleNames := make(map[string]bool, len(def.Roles))
		for _, role := range def.Roles {
			roleNames[role.Name] = true
		}
		for roleName := range adopt {
			if !roleNames[roleName] {
				return Workflow{}, fmt.Errorf("%w: adoptRuntime references unknown role %q", ErrValidation, roleName)
			}
		}
		for _, role := range def.Roles {
			if _, ok := adopt[role.Name]; !ok {
				return Workflow{}, fmt.Errorf("%w: adoptRuntime missing role %q", ErrValidation, role.Name)
			}
		}
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
	if len(adopt) > 0 {
		wf.Runtime = adopt
		wf.Status = StatusStarted
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
	// Nutzerwunsch 2026-07-28: ein endgültig gelöschter Workflow darf
	// keine verwaisten Rollenbindungen zurücklassen, die auf eine nicht
	// mehr existierende workflow_id zeigen (sonst zeigt die
	// Administration-Ansicht dauerhaft Bindungen für einen Workflow, den
	// es gar nicht mehr gibt). Best effort wie die Service-Prinzipal-
	// Bindung bei Start() — ein Fehler hier bricht das bereits
	// erfolgreiche Löschen des Workflows selbst nicht mehr ab.
	if s.authz != nil {
		if err := s.authz.DeleteByWorkflow(id); err != nil {
			slog.Warn("workflows: failed to clean up role bindings after delete", "workflow", id, "error", err)
		}
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
// Laufzeitzustand). includeBindings (Nutzerwunsch 2026-07-28, opt-in,
// Default false über den HTTP-Handler) hängt zusätzlich die aktuellen
// Workflow-gescopten Rollenbindungen an — bewusst nicht Teil des
// portablen Standard-Exports (s. ExportedWorkflow.Bindings-Doku), nur
// für den engeren Delete→Import-auf-demselben-System-Fall.
func (s *Service) Export(id string, includeBindings bool) (ExportedWorkflow, error) {
	wf, err := s.store.Get(id)
	if err != nil {
		return ExportedWorkflow{}, err
	}
	exported := ExportedWorkflow{Version: exportVersion, Name: wf.Name, Definition: wf.Definition}
	if includeBindings && s.authz != nil {
		bindings, err := s.authz.LoadByWorkflow(id)
		if err != nil {
			return ExportedWorkflow{}, err
		}
		for _, b := range bindings {
			exported.Bindings = append(exported.Bindings, ExportedBinding{Subject: b.Subject, Role: b.NodeID, Verb: b.Verb})
		}
	}
	return exported, nil
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

	wf, err := s.Create(name, exported.Definition, nil)
	if err != nil {
		return Workflow{}, err
	}

	// Nutzerwunsch 2026-07-28: mitexportierte Bindungen (s. Export)
	// gegen die neue Workflow-ID wiederherstellen — best effort, ein
	// einzelner Fehler (z. B. ein Subject, das inzwischen gelöscht
	// wurde) bricht den bereits erfolgreichen Import nicht ab.
	if s.authz != nil {
		for _, b := range exported.Bindings {
			if _, err := s.authz.Create(b.Subject, wf.ID, b.Role, b.Verb); err != nil {
				slog.Warn("workflows: failed to restore role binding on import", "workflow", wf.ID, "subject", b.Subject, "role", b.Role, "error", err)
			}
		}
	}

	return wf, nil
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

// Update überschreibt Name und Definition eines Workflows — in
// "stopped"/"paused" (§22.3 Punkt 2 / Kapitel 12 Teil 1,
// docs/END-GOAL-FEATURES.md §12.3c: "PUT /api/v1/workflows/{id} …
// §22.3 Punkt 2 einlösen"; Teil 3 §12.3c erweitert das ausdrücklich um
// "paused") UND jetzt auch "started" (Nutzerwunsch 2026-07-26: im
// Flow-Editor einen LAUFENDEN Workflow "wie eine Gruppe" betreten,
// Nodes hinzufügen/verschieben/verbinden, dann "im Workflow
// speichern"). Das ursprüngliche Sicherheitsargument ("kein
// Umschreiben der Definition unter noch laufenden Prozessen, die die
// alte Definition ausführen") gilt für eine BELIEBIGE neue Definition
// — hier ist der Aufrufer (ui/graph/flow-canvas.ts
// #saveRunningWorkflowFromLiveTopology) aber bewusst auf "erfasse den
// AKTUELL laufenden Stand als neue Definition" beschränkt: die neue
// Definition kann per Konstruktion nie von dem abweichen, was gerade
// läuft, es gibt also keinen Inkonsistenz-Fall. Sie wirkt erst beim
// NÄCHSTEN Start/Neustart — die laufenden Prozesse selbst bleiben
// unberührt. "starting"/"failed" bleiben weiterhin gesperrt (zu
// transiente/unklare Zustände für diese Garantie).
func (s *Service) Update(id, name string, def Definition) (Workflow, error) {
	if err := validate(def); err != nil {
		return Workflow{}, err
	}
	wf, err := s.store.Get(id)
	if err != nil {
		return Workflow{}, err
	}
	if wf.Status != StatusStopped && wf.Status != StatusPaused && wf.Status != StatusStarted {
		return Workflow{}, ErrNotStopped
	}
	wf.Name = name
	wf.Definition = def
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		return Workflow{}, err
	}
	// Bugfix 2026-07-26 (Nutzer-Fund: "Mixer merkt sich nach Stop/Start
	// immer noch die Sources"): ein gespeicherter Rollen-Zustand gehört
	// zur ALTEN Topologie (Rollen-Positionen/Verkabelung, s. state.go
	// senderAliasPrefix-Doku) — best effort, kein Abbruch des im Kern
	// bereits erfolgreichen Updates, falls das Leeren selbst fehlschlägt.
	if err := s.store.ClearRoleState(id); err != nil {
		slog.Warn("workflows: failed to clear role state after update", "workflow", id, "error", err)
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

	// D8 Teil 2 (ARCHITECTURE.md §15.1 Punkt 2): Latenzbudget-Preflight
	// VOR jeder Provisionierung (noch kein StatusStarting, noch kein
	// einziger Node gestartet) — reine Berechnung auf Definition+Katalog,
	// kein I/O nötig, deshalb synchron statt in runStart (anders als die
	// eigentliche Host-Platzierung, die auf Live-Telemetrie wartet).
	if err := checkLatencyBudget(wf.Definition, s.launcher.Catalog()); err != nil {
		return err
	}
	// D8 Teil 3 (ARCHITECTURE.md §15.1 Punkt 3): zweiter, ebenfalls rein
	// auf Definition+Katalog rechnender Preflight — schlägt fehl, wenn
	// ein zu kurzer Pfad KEINEN delay-fähigen Node hat oder zwei Pfade
	// widersprüchliche Verzögerungen von derselben Rolle verlangen. Der
	// eigentliche Plan wird hier verworfen (nur die Fehlerprüfung zählt)
	// und in runStart erneut berechnet, nachdem die Rollen registriert
	// sind (dort werden die setOutputDelay-Methodenaufrufe angewendet).
	if _, err := computeDelayPlan(wf.Definition, s.launcher.Catalog()); err != nil {
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

// runStart führt die eigentliche Provisionierung aus (Hintergrund-
// Goroutine, s. Start()). Fehler bei einzelnen Rollen werden gesammelt
// statt beim ersten Fehler abzubrechen (gleiches Muster wie
// snapshots.Service.Apply) — der Workflow landet dann in "failed" mit
// einer verständlichen Fehlermeldung, bereits gestartete Rollen bleiben
// **absichtlich laufen** (kein automatisches Rollback: ein Teil-Start ist
// im Zweifel nützlicher als ein sofortiger Stopp mitten in der
// Provisionierung, und die Rollen sind über den Workflow jederzeit per
// Stop() gebündelt wieder zu beenden).
//
// Host-Platzierung (Nachtrag 99, löst die vormals harte checkResources-
// Vorbedingung ab): pro Rolle, IN Reihenfolge von Definition.Roles
// (damit mehrere Rollen DESSELBEN Starts sich gegenseitig als
// Affinitäts-/Redundanz-Nachbarn sehen, nicht nur bereits laufende
// andere Workflows), s.resources.SelectHost() aufrufen statt role.HostID
// ungeprüft zu verwenden — der Start soll laut Vorgabe IMMER gelingen,
// nur eben ggf. anderswo als in der Definition eingetragen. s.resources
// darf nil sein (z. B. Tests ohne verdrahtete Placement-Engine) — dann
// bleibt role.HostID unverändert wie vor Nachtrag 99.
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

	// Nachtrag 99: Ausgangs-Belegung aus ALLEN ANDEREN Workflows (jetzt
	// laufend + Scheduler-Forecast) — einmal pro Start gebaut, dann
	// unten pro Rolle um die bereits IN DIESEM Start aufgelösten
	// Geschwister-Rollen ergänzt (s. Merge unten), damit z. B. zwei
	// Rollen mit derselben RedundancyGroup im selben Start sich
	// gegenseitig ausweichen, nicht nur bereits laufenden Workflows.
	occ := s.buildOccupancy(time.Now())

	pending := map[string]string{} // roleName -> instanceID, noch nicht in der Registry gesehen
	for _, role := range wf.Definition.Roles {
		resolvedHostID := role.HostID
		var placementReason string
		if s.resources != nil {
			result := s.resources.SelectHost(placement.PlacementRequest{
				NodeType:        role.NodeType,
				PreferredHostID: role.HostID,
				AffinityGroup:   role.AffinityGroup,
				RedundancyGroup: role.RedundancyGroup,
			}, occ)
			resolvedHostID = result.HostID
			placementReason = result.Reason
		}

		// Nutzerwunsch 2026-07-28: role.Format überschreibt (pro Rolle,
		// nicht workflow-weit) OMP_WIDTH/OMP_HEIGHT aus der Programm-
		// Auflösung oben plus neu OMP_FRAMERATE_NUM/OMP_FRAMERATE_DEN —
		// eigene Map statt Mutation von extraEnv, damit die nächste
		// Rolle in dieser Schleife nicht versehentlich das Format der
		// vorigen erbt.
		roleEnv := extraEnv
		if roleFormatEnv := formatExtraEnv(role.Format); roleFormatEnv != nil {
			roleEnv = make(map[string]string, len(extraEnv)+len(roleFormatEnv))
			for k, v := range extraEnv {
				roleEnv[k] = v
			}
			for k, v := range roleFormatEnv {
				roleEnv[k] = v
			}
		}

		inst, err := s.launcher.StartLabeled(role.NodeType, "", resolvedHostID, role.Name, roleEnv)
		if err != nil {
			s.fail(wf, fmt.Sprintf("role %s: start failed: %v", role.Name, err))
			return
		}
		wf.Runtime[role.Name] = RoleRuntime{InstanceID: inst.ID, HostID: resolvedHostID}
		pending[role.Name] = inst.ID
		if placementReason != "" && resolvedHostID != role.HostID {
			slog.Info("workflows: role placed on a different host than preferred",
				"workflow", wf.ID, "role", role.Name, "preferredHostId", role.HostID,
				"resolvedHostId", resolvedHostID, "reason", placementReason)
		}
		// Geschwister-Rollen DESSELBEN Starts als Nachbarn sichtbar
		// machen, bevor die nächste Rolle aufgelöst wird (s. Doku oben).
		if role.AffinityGroup != "" {
			occ.AffinityGroupHosts[role.AffinityGroup] = append(occ.AffinityGroupHosts[role.AffinityGroup], resolvedHostID)
		}
		if role.RedundancyGroup != "" {
			occ.RedundancyGroupHosts[role.RedundancyGroup] = append(occ.RedundancyGroupHosts[role.RedundancyGroup], resolvedHostID)
		}

		// ARCHITECTURE.md §24.1, UMSETZUNG.md C16: Control-Plane-Rollen
		// (s. controlPlaneNodeTypes) bekommen sofort eine Workflow-
		// gescopte VerbOperate-Bindung auf ihre eigene Instanz-ID —
		// best effort wie der Zwischenstand unten: ein Fehler hier
		// bricht den Workflow-Start nicht ab (die Instanz läuft bereits
		// und ist über den bisherigen Direktpfad weiter erreichbar,
		// s. docs/decisions.md Nachtrag 81/C16 zur Migration), sie kann
		// sich nur ohne Bindung kein Service-Token holen.
		if s.authz != nil && controlPlaneNodeTypes[role.NodeType] {
			if _, err := s.authz.Create(inst.ID, wf.ID, authz.AnyNode, authz.VerbOperate); err != nil {
				slog.Warn("workflows: failed to provision service-token role binding",
					"workflow", wf.ID, "role", role.Name, "instance", inst.ID, "error", err)
			}
		}
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

	// D8 Teil 3 (ARCHITECTURE.md §15.1 Punkt 3): Plan erneut berechnen
	// (Start() hat ihn bereits als Preflight validiert, hier nur noch
	// angewendet) und per setOutputDelay auf die jetzt registrierten
	// Rollen anwenden — VOR dem ersten produzierten Frame, damit kein
	// Delay-loser Anfangsabschnitt entsteht.
	s.applyDelayPlan(ctx, wf)

	wf.Status = StatusStarted
	wf.Error = ""
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: failed to persist started state", "id", wf.ID, "error", err)
	}
	s.publish(wf)

	// Bugfix 2026-07-26 (Nachtrag 91 Punkt 4): den beim letzten Stop/
	// Pause erfassten Bedienzustand (PGM/PST, DSK/PIP-Quelle o. Ä.)
	// wiederherstellen — sonst würde der Crosspoint erst durch das
	// nächste manuelle Umschalten wieder auf den vorherigen Stand
	// zurückkehren.
	s.restoreRoleState(wf)
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

	// Live gefunden (K7 Teil 4, Hot-Standby-Live-Test): awaitFreshRegistration
	// oben kann mehrere Sekunden dauern — in dieser Zeit kann ein NEUERES
	// Ereignis für dieselbe Rolle bereits gewonnen haben, z. B. eine
	// promoteStandby-Übernahme (failover.go) auf eine ANDERE Instanz.
	fresh, ok := s.stillBacks(workflowID, role, instanceID)
	if !ok {
		return
	}
	wf = fresh

	rt := wf.Runtime[role]
	rt.NodeID = node.ID
	wf.Runtime[role] = rt

	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != role && conn.ToRole != role {
			continue
		}

		// Zweite, PRO VERBINDUNG wiederholte Prüfung — live gefunden
		// (Hot-Standby-Live-Test): die vorige applyConnection-Anwendung
		// dieser selben Schleife (z. B. waitForCrosspointInput) kann selbst
		// bis zu ~10-20s bis zu ihrem eigenen Timeout blockieren. Ein reiner
		// Check VOR der Schleife (oben) reicht deshalb NICHT — ohne diesen
		// zweiten Check würde eine WÄHREND der Schleife (nicht nur davor)
		// eintreffende Standby-Übernahme übersehen, und die NÄCHSTE
		// Connection dieser Schleife (hier: "active"->"view") würde trotzdem
		// real gepatcht — mit dem längst toten Sender der überholten
		// Primär-Instanz. Live reproduziert: `view`s Receiver wurde nach
		// einer bereits erfolgreichen Standby-Übernahme fälschlich wieder
		// auf den verschwundenen Sender der ursprünglichen (gecrashten)
		// Instanz zurückgepatcht, weil genau dieser Zwischen-Check fehlte.
		if _, ok := s.stillBacks(workflowID, role, instanceID); !ok {
			slog.Info("workflows: rewireAfterRestart: role superseded mid-reconnect, aborting remaining connections",
				"workflow", wf.ID, "role", role, "instance", instanceID)
			return
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

	// Maßgebliche, letzte Prüfung unmittelbar vor dem Persistieren — deckt
	// das letzte kurze Zeitfenster nach der letzten Connection ab (s.
	// stillBacks-Doku: dieselbe Frage wird an mehreren Stellen dieser
	// Funktion neu gestellt, da jede der potenziell langsamen I/O-Operation
	// dazwischen eine neuere Übernahme unsichtbar verpassen könnte).
	final, ok := s.stillBacks(workflowID, role, instanceID)
	if !ok {
		slog.Info("workflows: rewireAfterRestart: role superseded by a newer event, dropping stale rewiring",
			"workflow", wf.ID, "role", role, "instance", instanceID)
		return
	}
	wf = final
	wf.Runtime[role] = rt

	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: rewireAfterRestart: persist failed", "workflow", wf.ID, "error", err)
	}
	s.publish(wf)
	slog.Info("workflows: rewired role after automatic restart", "workflow", wf.ID, "role", role, "instance", instanceID)
}

// stillBacks lädt den Workflow frisch nach und meldet, ob role dort
// weiterhin (Status "started" vorausgesetzt) GENAU von instanceID erfüllt
// wird — wiederverwendet an mehreren Stellen in rewireAfterRestart, die
// über potenziell langsames I/O hinweg (Registrierungs-Warten,
// Connection-Anwendung) wiederholt dieselbe Frage stellen müssen: "gilt
// das, was ich gerade tue, noch, oder hat mich eine neuere Übernahme
// (K7 Teil 4, promoteStandby) oder ein noch neuerer Restart bereits
// überholt?" (s. Live-Fund-Dokumentation dort).
func (s *Service) stillBacks(workflowID, role, instanceID string) (Workflow, bool) {
	wf, err := s.store.Get(workflowID)
	if err != nil || wf.Status != StatusStarted || wf.Runtime[role].InstanceID != instanceID {
		return Workflow{}, false
	}
	return wf, true
}

// RestartRole startet die Instanz EINER Rolle eines bereits laufenden
// Workflows neu, optional mit einem neuen `role.Format` — Nutzerwunsch
// 2026-07-29 ("scaler hat immer noch keine Auswahl im Property-Editor
// für Format"): der Property-Editor eines laufenden Nodes (generisches
// Panel, `flow-canvas.ts`, für Node-Typen ohne eigenes UI-Bundle wie
// `omp-scaler`/`omp-source`) zeigte bisher nur readonly-Parameter — ein
// neues Zielformat ließ sich nur über den (nur bei gestopptem Workflow
// erreichbaren) grafischen Rollen-Designer setzen. Statt einer echten
// Live-Rekonfiguration der laufenden MXL-Ausgangs-Flow (deutlich
// riskanter, gleiche Bug-Kategorie wie die frühere
// `swap_input_resolution`-Baustelle, s. `UMSETZUNG.md`) startet dies nur
// die EINE betroffene Rolle neu — der Rest des Workflows läuft
// unterbrechungsfrei weiter, exakt der vom Projektinhaber gewählte
// Ansatz. Persistiert die Formatänderung sofort synchron (sichtbar auch
// falls der Neustart selbst fehlschlägt); der eigentliche Stop/Start/
// Reconnect läuft danach asynchron im Hintergrund (`runRestartRole`),
// gleiches Muster wie `Start()`/`Stop()` — ein synchroner Handler würde
// sonst bis zu `registrationTimeout` blockieren.
func (s *Service) RestartRole(ctx context.Context, id, roleName, format string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted {
		return ErrNotRunning
	}
	roleIdx := -1
	for i, r := range wf.Definition.Roles {
		if r.Name == roleName {
			roleIdx = i
			break
		}
	}
	if roleIdx == -1 {
		return fmt.Errorf("%w: role %q not found", ErrValidation, roleName)
	}
	if format != "" {
		if _, ok := standardFormats[format]; !ok {
			return fmt.Errorf("%w: unknown format %q (not one of %v)", ErrValidation, format, StandardFormatNames())
		}
	}

	wf.Definition.Roles[roleIdx].Format = format
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		return err
	}
	s.publish(wf)

	go s.runRestartRole(wf, roleName)
	return nil
}

// runRestartRole führt den eigentlichen Neustart aus RestartRole aus:
// alte Instanz stoppen, neue mit dem (bereits in wf.Definition
// persistierten) Format starten, auf ihre Registrierung warten und alle
// Connections neu anwenden, die diese Rolle betreffen — letzteres
// dieselbe Logik wie `rewireAfterRestart` nach einem Crash-Neustart,
// hier nur bewusst statt reaktiv ausgelöst. Best effort: Fehler landen
// im Log statt die Rolle über `fail()` in einen Workflow-weiten
// "failed"-Zustand zu versetzen — ein einzelner Rollen-Neustart, der
// nicht klappt, soll die übrigen, weiterlaufenden Rollen nicht als
// Kollateralschaden mit reißen.
func (s *Service) runRestartRole(wf Workflow, roleName string) {
	role, ok := roleByName(wf, roleName)
	if !ok {
		return
	}

	if oldRuntime, hadOld := wf.Runtime[roleName]; hadOld && oldRuntime.InstanceID != "" {
		if err := s.launcher.Stop(oldRuntime.InstanceID); err != nil {
			slog.Warn("workflows: RestartRole: stop old instance failed", "workflow", wf.ID, "role", roleName, "error", err)
		}
	}

	extraEnv := map[string]string{}
	if wf.Definition.Settings.ProgramWidth > 0 {
		extraEnv["OMP_WIDTH"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramWidth), 10)
	}
	if wf.Definition.Settings.ProgramHeight > 0 {
		extraEnv["OMP_HEIGHT"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramHeight), 10)
	}
	roleEnv := extraEnv
	if roleFormatEnv := formatExtraEnv(role.Format); roleFormatEnv != nil {
		roleEnv = make(map[string]string, len(extraEnv)+len(roleFormatEnv))
		for k, v := range extraEnv {
			roleEnv[k] = v
		}
		for k, v := range roleFormatEnv {
			roleEnv[k] = v
		}
	}

	resolvedHostID := role.HostID
	if s.resources != nil {
		occ := s.buildOccupancy(time.Now())
		result := s.resources.SelectHost(placement.PlacementRequest{
			NodeType:        role.NodeType,
			PreferredHostID: role.HostID,
			AffinityGroup:   role.AffinityGroup,
			RedundancyGroup: role.RedundancyGroup,
		}, occ)
		resolvedHostID = result.HostID
	}

	inst, err := s.launcher.StartLabeled(role.NodeType, "", resolvedHostID, role.Name, roleEnv)
	if err != nil {
		slog.Warn("workflows: RestartRole: start failed", "workflow", wf.ID, "role", roleName, "error", err)
		return
	}
	wf.Runtime[roleName] = RoleRuntime{InstanceID: inst.ID, HostID: resolvedHostID}
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: RestartRole: persist intermediate state failed", "workflow", wf.ID, "role", roleName, "error", err)
	}
	s.publish(wf)

	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	defer cancel()
	if err := s.awaitRegistration(ctx, wf, map[string]string{roleName: inst.ID}); err != nil {
		slog.Warn("workflows: RestartRole: registration timed out", "workflow", wf.ID, "role", roleName, "error", err)
		return
	}

	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != roleName && conn.ToRole != roleName {
			continue
		}
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			slog.Warn("workflows: RestartRole: sender role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			slog.Warn("workflows: RestartRole: receiver role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout)
		err := s.applyConnection(connectCtx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		connectCancel()
		if err != nil {
			slog.Warn("workflows: RestartRole: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}

	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: RestartRole: persist final state failed", "workflow", wf.ID, "role", roleName, "error", err)
	}
	s.publish(wf)
	slog.Info("workflows: restarted role", "workflow", wf.ID, "role", roleName, "instance", inst.ID)
}

func roleByName(wf Workflow, roleName string) (Role, bool) {
	for _, r := range wf.Definition.Roles {
		if r.Name == roleName {
			return r, true
		}
	}
	return Role{}, false
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

// formatVideo/formatAudio sind die IS-04 flow.Format-Werte, wie sie
// registry.SenderView.Format/ReceiverView.Format direkt aus der Registry
// übernehmen (s. registry/client.go buildSnapshot) — hier nur benannt,
// um sie in findSenders format-bewusster Auswahl unten nicht als
// magische Strings zu wiederholen.
const (
	formatVideo = "urn:x-nmos:format:video"
	formatAudio = "urn:x-nmos:format:audio"
)

// applyConnection löst eine einzelne Workflow-Connection auf: ein echter
// IS-05 Connect, falls die Zielrolle einen IS-04-Receiver hat (Standard-
// fall, z. B. omp-viewer); sonst ein Crosspoint-Methodenaufruf, falls der
// Zielrollen-Node-Typ in crosspointByNodeType bekannt ist (s.
// Connection-Doku in types.go); sonst ein verständlicher Fehler statt
// eines stillen No-Op.
//
// **Live-Bug gefunden 2026-07-29 (Nutzerreport "Scaler erzeugt keinen
// Output-Stream"):** Der Sender wurde bisher VOR dem Receiver aufgelöst,
// ohne dessen Format zu kennen — der leere-Label-Fallback in findSender
// nahm deshalb blind `node.Senders[0]`. Für eine Rolle mit mehreren
// Sendern unterschiedlichen Formats (z. B. `omp-source`: Video- UND
// Audio-Sender seit dem Audio-Companion-Pattern, `[[project_c21_live_mxl_
// playlist_item_done]]`) landete eine unbeschriftete Connection
// registrierungsreihenfolge-abhängig auch mal auf dem Audio-Sender, selbst
// wenn die Zielrolle (hier `omp-scaler`) nur einen Video-Receiver hat.
// Live reproduziert: `omp-scaler` bekam per IS-05-PATCH die `flow_id`
// von `src`s Audio-Sender zugewiesen, `MxlVideoInput::new` scheiterte
// erwartungsgemäß an `flow_def: frame_width fehlt` (Audio-Flow-Def hat
// kein `frame_width`) — die Pipeline baute nie auf, kein Output-Stream.
// Fix: Receiver zuerst auflösen (sein Format steht direkt am Resource,
// s. registry/types.go), dann den Sender bevorzugt auf dasselbe Format
// filtern — nur bei explizitem `FromSender`-Label unverändert (Label
// schlägt Format-Präferenz). Der Crosspoint-Zweig bekommt dieselbe
// Behandlung mit fest `formatVideo` (`crosspointByNodeType` enthält
// heute ausschließlich Video-Crosspoints, s. Map oben).
func (s *Service) applyConnection(ctx context.Context, conn Connection, fromNode, toNode registry.NodeView, toRoleNodeType string) error {
	if len(toNode.Receivers) > 0 {
		receiver, ok := findReceiver(toNode, conn.ToReceiver)
		if !ok {
			return fmt.Errorf("connection %s -> %s: role %s has no receiver%s", conn.FromRole, conn.ToRole, conn.ToRole, labelSuffix(conn.ToReceiver))
		}
		sender, ok := findSender(fromNode, conn.FromSender, receiver.Format)
		if !ok {
			return fmt.Errorf("connection %s -> %s: role %s has no sender%s", conn.FromRole, conn.ToRole, conn.FromRole, labelSuffix(conn.FromSender))
		}
		return s.graph.Connect(ctx, sender.ID, receiver.ID)
	}

	if cp, ok := crosspointByNodeType[toRoleNodeType]; ok {
		sender, ok := findSender(fromNode, conn.FromSender, formatVideo)
		if !ok {
			return fmt.Errorf("connection %s -> %s: role %s has no sender%s", conn.FromRole, conn.ToRole, conn.FromRole, labelSuffix(conn.FromSender))
		}
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
// bedeutet den bisherigen Kompatibilitäts-Fallback (erster Sender),
// jetzt zusätzlich format-bewusst: unter mehreren unbeschrifteten
// Sendern wird der erste GEWÄHLT, dessen Format zu preferFormat passt
// (leer = keine Präferenz, unverändertes Verhalten); passt keiner,
// bleibt der alte blinde Fallback (node.Senders[0]) — lieber eine
// zunächst falsch verkabelte, aber sichtbar fehlschlagende Connection
// als ein harter Fehler für Aufrufer, die (noch) kein Format kennen.
//
// Unter den format-passenden Sendern wird zusätzlich ein "Lowres"-
// Companion-Sender (`{label} Lowres`, einheitliche Namenskonvention in
// omp-source/omp-ograf/omp-player) übersprungen, solange ein
// gleich-formatiger Nicht-Lowres-Sender existiert: sonst würde eine
// unbeschriftete Connection lautlos auf dem 640×360-Vorschau-Companion
// statt dem Hauptsignal landen — kein Fehler, nur eine leise falsche
// Wahl, die schwerer auffällt als der ursprüngliche Bug (live gefunden,
// direkt im Anschluss an den Scaler-"kein Output"-Fix: unbeschriftetes
// src->scaler verband ohne dies auf `src Lowres` statt `src`).
func findSender(node registry.NodeView, label, preferFormat string) (registry.SenderView, bool) {
	if label == "" {
		if len(node.Senders) == 0 {
			return registry.SenderView{}, false
		}
		if preferFormat != "" {
			for _, sndr := range node.Senders {
				if sndr.Format == preferFormat && !isLowresCompanion(sndr.Label) {
					return sndr, true
				}
			}
			for _, sndr := range node.Senders {
				if sndr.Format == preferFormat {
					return sndr, true
				}
			}
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

func isLowresCompanion(label string) bool {
	return strings.HasSuffix(label, "Lowres")
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
	// Bugfix 2026-07-26 (Nachtrag 91 Punkt 4): Bedienzustand jeder Rolle
	// erfassen, bevor ihr Prozess gestoppt wird — danach ist der Node
	// weg und hat nichts mehr zu befragen.
	s.captureRoleState(wf)

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
		if r.Format != "" {
			if _, ok := standardFormats[r.Format]; !ok {
				return fmt.Errorf("%w: role %q references unknown format %q (not one of %v)", ErrValidation, r.Name, r.Format, StandardFormatNames())
			}
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
	// K7 Teil 4 (Hot-Standby, docs/END-GOAL-FEATURES.md §7.4): StandbyFor
	// muss eine andere, existierende Rolle desselben NodeTypes referenzieren
	// — keine Selbstreferenz, keine Ketten (eine Rolle ist entweder Primär-
	// oder Standby-Rolle, nie beides), höchstens ein Standby pro Primärrolle.
	roleByName := map[string]Role{}
	for _, r := range def.Roles {
		roleByName[r.Name] = r
	}
	standbyOfPrimary := map[string]string{} // primaryRole -> standbyRole (Eindeutigkeit)
	for _, r := range def.Roles {
		if r.StandbyFor == "" {
			continue
		}
		if r.StandbyFor == r.Name {
			return fmt.Errorf("%w: role %q cannot be a standby for itself", ErrValidation, r.Name)
		}
		primary, ok := roleByName[r.StandbyFor]
		if !ok {
			return fmt.Errorf("%w: role %q references unknown standbyFor role %q", ErrValidation, r.Name, r.StandbyFor)
		}
		if primary.NodeType != r.NodeType {
			return fmt.Errorf("%w: standby role %q (%s) must match nodeType of %q (%s)", ErrValidation, r.Name, r.NodeType, r.StandbyFor, primary.NodeType)
		}
		if primary.StandbyFor != "" {
			return fmt.Errorf("%w: role %q is itself a standby role, cannot have a standby (no chains)", ErrValidation, r.StandbyFor)
		}
		if existing, ok := standbyOfPrimary[r.StandbyFor]; ok {
			return fmt.Errorf("%w: role %q already has a standby role %q, at most one standby per primary", ErrValidation, r.StandbyFor, existing)
		}
		standbyOfPrimary[r.StandbyFor] = r.Name
	}

	// D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2):
	// nur die drei dokumentierten Eskalationsstufen sind gültig — leer
	// zählt als "advisory" (Default, s. Role.Placement-Doku), kein
	// eigener Sonderfall nötig.
	for _, r := range def.Roles {
		switch esc := r.PlacementEscalation(); esc {
		case EscalationAdvisory, EscalationAutoConfirmWindow, EscalationAuto:
		default:
			return fmt.Errorf("%w: role %q has unknown placement escalation %q", ErrValidation, r.Name, esc)
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

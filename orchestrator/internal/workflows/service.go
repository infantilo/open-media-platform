package workflows

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

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
	Start(nodeType, hostID string, extraEnv map[string]string) (launcher.Instance, error)
	Stop(id string) error
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
}

// Service verwaltet Workflow-Definitionen und führt Bundle-Start/-Stop
// aus (ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1).
type Service struct {
	store    workflowStore
	nodes    NodeLister
	graph    GraphService
	launcher Launcher
	events   EventPublisher
}

// NewService verbindet Postgres-Store, Node-Registry-Sicht, Graph-Service
// und Instanz-Launcher zu einem Workflow-Service. events darf nil sein
// (z. B. in Tests) — dann bleiben Statuswechsel SSE-still, nur per Poll
// sichtbar.
func NewService(store *Store, nodes NodeLister, graphSvc GraphService, l Launcher, events EventPublisher) *Service {
	return &Service{store: store, nodes: nodes, graph: graphSvc, launcher: l, events: events}
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

// Delete entfernt einen Workflow — nur im Zustand "stopped" (kein
// stilles Verwaisen laufender Prozesse: erst stoppen, dann löschen).
func (s *Service) Delete(id string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStopped {
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

// Start provisioniert alle Rollen eines Workflows (lokal oder remote,
// s. Launcher) und verkabelt sie gemäß Verbindungs-Template, sobald sie
// in der NMOS-Registry erscheinen. Läuft im Hintergrund weiter, nachdem
// Start() zurückkehrt — der Aufrufer sieht sofort den Zwischenzustand
// "starting" und kann per GET /api/v1/workflows/{id} (oder SSE) den
// weiteren Fortschritt beobachten. Das hält den HTTP-Handler kurz, auch
// wenn reale GStreamer-Pipelines mehrere Sekunden zum Hochfahren
// brauchen.
func (s *Service) Start(ctx context.Context, id string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStopped && wf.Status != StatusFailed {
		return ErrNotStopped
	}

	wf.Status = StatusStarting
	wf.Error = ""
	wf.Runtime = map[string]RoleRuntime{}
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		return err
	}
	s.publish(wf)

	go s.runStart(wf)
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
		inst, err := s.launcher.Start(role.NodeType, role.HostID, extraEnv)
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
	if err := s.store.Put(wf); err != nil {
		slog.Warn("workflows: failed to persist intermediate state", "id", wf.ID, "error", err)
	}

	if err := s.awaitRegistration(ctx, wf, pending); err != nil {
		s.fail(wf, err.Error())
		return
	}

	for _, conn := range wf.Definition.Connections {
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok || len(fromNode.Senders) == 0 {
			s.fail(wf, fmt.Sprintf("connection %s -> %s: role %s has no sender", conn.FromRole, conn.ToRole, conn.FromRole))
			return
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok || len(toNode.Receivers) == 0 {
			s.fail(wf, fmt.Sprintf("connection %s -> %s: role %s has no receiver", conn.FromRole, conn.ToRole, conn.ToRole))
			return
		}
		if err := s.graph.Connect(ctx, fromNode.Senders[0].ID, toNode.Receivers[0].ID); err != nil {
			s.fail(wf, fmt.Sprintf("connection %s -> %s: %v", conn.FromRole, conn.ToRole, err))
			return
		}
	}

	wf.Status = StatusStarted
	wf.Error = ""
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		slog.Warn("workflows: failed to persist started state", "id", wf.ID, "error", err)
	}
	s.publish(wf)
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
		if !ok || len(fromNode.Senders) == 0 {
			slog.Warn("workflows: rewireAfterRestart: sender not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok || len(toNode.Receivers) == 0 {
			slog.Warn("workflows: rewireAfterRestart: receiver not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout)
		err := s.graph.Connect(connectCtx, fromNode.Senders[0].ID, toNode.Receivers[0].ID)
		connectCancel()
		if err != nil {
			slog.Warn("workflows: rewireAfterRestart: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}

	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		slog.Warn("workflows: rewireAfterRestart: persist failed", "workflow", wf.ID, "error", err)
	}
	s.publish(wf)
	slog.Info("workflows: rewired role after automatic restart", "workflow", wf.ID, "role", role, "instance", instanceID)
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
	if err := s.store.Put(wf); err != nil {
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
func (s *Service) Stop(ctx context.Context, id string) error {
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted && wf.Status != StatusFailed && wf.Status != StatusStarting {
		return ErrNotRunning
	}

	wf.Status = StatusStopping
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		return err
	}
	s.publish(wf)

	go s.runStop(wf)
	return nil
}

func (s *Service) runStop(wf Workflow) {
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
		wf.Status = StatusStopped
		wf.Error = ""
	}
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
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
	seen := map[string]bool{}
	for _, r := range def.Roles {
		if r.Name == "" || r.NodeType == "" {
			return fmt.Errorf("%w: role name and nodeType required", ErrValidation)
		}
		if seen[r.Name] {
			return fmt.Errorf("%w: duplicate role name %q", ErrValidation, r.Name)
		}
		seen[r.Name] = true
	}
	for _, c := range def.Connections {
		if !seen[c.FromRole] {
			return fmt.Errorf("%w: connection references unknown role %q", ErrValidation, c.FromRole)
		}
		if !seen[c.ToRole] {
			return fmt.Errorf("%w: connection references unknown role %q", ErrValidation, c.ToRole)
		}
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

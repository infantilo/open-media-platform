// Package instancemigrate (Kapitel 13 Teil 3, docs/END-GOAL-FEATURES.md
// §13.4: "Drag = begleiteter Umzug ... Neu-Verkabelung über den
// bestehenden Workflow-/Graph-Pfad") implementiert den begleiteten
// Host-Umzug für EIGENSTÄNDIGE, nicht Workflow-gebundene Node-Instanzen
// (Nutzerentscheidung 2026-08-12: nur diese erscheinen heute individuell
// in den Host-Zonen-Lanes des Flow-Editors — ein laufender Workflow
// zeigt sich dort immer als EINE kollabierte Kachel, s. dortige
// Doku/Nutzerentscheidung 2026-07-26, seine Rollen sind daher kein
// gültiges Drag-Ziel; für sie existiert stattdessen
// workflows.Service.MigrateRole, noch ohne UI-Anschluss).
//
// Ablauf (seit 2026-11-02 make-before-break, wie beim Workflow-Pfad): eine
// neue Instanz vom selben Node-Typ auf dem Zielhost starten, ihre
// Registrierung abwarten, alle Kanten der alten Instanz auf sie umschalten
// — Zuordnung über Port-ROLLE (Seite + Index in der IS-04-Registrierungs-
// reihenfolge), nicht über die IDs selbst, da Sender-/Receiver-IDs bei
// jedem Neustart neu vergeben werden — und ERST DANN die alte stoppen.
// Scheitert der Start auf dem Zielhost, läuft die alte unverändert weiter.
package instancemigrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

var (
	registrationPollInterval = 200 * time.Millisecond
	registrationTimeout      = 15 * time.Second
)

// ErrUnknownInstance wird geliefert, wenn oldInstanceID dem Launcher
// unbekannt ist.
var ErrUnknownInstance = errors.New("instancemigrate: unknown instance")

// ErrNotRegistered wird geliefert, wenn die Instanz zwar dem Launcher
// bekannt ist, aber (noch) keinen zugehörigen Node im Registry-Snapshot
// hat — z. B. unmittelbar nach dem Start, bevor die IS-04-Registrierung
// durchgelaufen ist.
var ErrNotRegistered = errors.New("instancemigrate: instance is not registered as a node yet")

// ErrSameHost wird geliefert, wenn targetHostID bereits der aktuelle
// Host der Instanz ist — ein Umzug wäre ein wirkungsloser Stop+Start.
var ErrSameHost = errors.New("instancemigrate: instance is already on the target host")

// ErrWorkflowRole: die Instanz erfüllt eine Workflow-Rolle. Ein Einzelumzug ließe die Zuordnung des Workflows auf
// die alte, dann gestoppte Instanz zeigen — dafür gibt es den Rollen-Umzug (workflows.Service.MigrateRole).
var ErrWorkflowRole = errors.New("instancemigrate: instance belongs to a workflow role, migrate the role instead")

// ErrMXLPeer: die Instanz hängt über MXL (host-lokal) an einem Node auf einem anderen Host als dem Ziel — nach dem
// Umzug bliebe dessen Signal stehen.
var ErrMXLPeer = errors.New("instancemigrate: instance is connected via MXL to a node on another host than the target")

// RoleFinder meldet, ob eine Instanz eine Workflow-Rolle erfüllt (workflows.Service).
type RoleFinder interface {
	FindRoleForInstance(instanceID string) (workflowID, role string, ok bool)
}

// handoverWait: so lange wartet der Einzelumzug darauf, dass Verbraucher (Viewer, Bild-/Tonmischer) die neue Quelle
// übernommen haben, bevor die alte Instanz stoppt (gleiche Frist wie beim Rollen-Umzug). var für Tests.
var handoverWait = 90 * time.Second

// NodeLister liefert den zuletzt bekannten Node-Snapshot — dieselbe
// Teilmenge wie graph.NodeLister/workflows' eigene, hier separat
// definiert (Go-Idiom: kleine Interfaces am Verwendungsort statt einer
// gemeinsamen, paketübergreifenden Abstraktion).
type NodeLister interface {
	List() []registry.NodeView
}

// LauncherService ist die von Service genutzte Teilmenge von
// *launcher.Launcher.
type LauncherService interface {
	Get(id string) (launcher.Instance, bool)
	StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error)
	// StartPinned: wie StartLabeled, aber aus einer bestimmten Binary-Version und mit den
	// Instanz-Optionen der Instanz optionsFrom (Kapitel 28 Schritt 3 / Kapitel 29).
	StartPinned(nodeType, version, hostID, customLabel string, extraEnv map[string]string, optionsFrom, pin string) (launcher.Instance, error)
	Stop(id string) error
}

// OptionMover überträgt die Instanz-Optionen auf die neue Instanz-ID (*nodeoptions.Store).
type OptionMover interface {
	MoveInstance(from, to string) error
}

// GraphService ist die von Service genutzte Teilmenge von
// *graph.Service.
type GraphService interface {
	Graph(ctx context.Context) graph.Graph
	Connect(ctx context.Context, fromSender, toReceiver string) error
}

// Service verbindet Launcher und Graph für MigrateInstance.
type Service struct {
	nodes    NodeLister
	launcher LauncherService
	graph    GraphService
	options  OptionMover
	// httpClient für Zustandsabfragen an Nodes (nil = http.DefaultClient).
	httpClient *http.Client
	// roles: optional; verhindert den Einzelumzug von Workflow-Rollen.
	roles RoleFinder
}

// SetRoleFinder verdrahtet die Prüfung "gehört die Instanz zu einem Workflow?".
func (s *Service) SetRoleFinder(f RoleFinder) { s.roles = f }

// SetHTTPClient setzt den Client für Anfragen an Node-APIs (Token/mTLS wie im übrigen Orchestrator).
func (s *Service) SetHTTPClient(c *http.Client) { s.httpClient = c }

// SetOptionMover setzt den Speicher, dessen Instanz-Optionen bei RestartInPlace mitwandern.
func (s *Service) SetOptionMover(m OptionMover) { s.options = m }

func NewService(nodes NodeLister, launcherSvc LauncherService, graphSvc GraphService) *Service {
	return &Service{nodes: nodes, launcher: launcherSvc, graph: graphSvc}
}

// edgeRef hält fest, über welchen Port (Seite+Index, NICHT die ID) der
// ALTEN Node eine Kante lief, und die (über den Neustart hinweg
// stabile) ID am jeweils ANDEREN Ende.
type edgeRef struct {
	side  string // "input" oder "output", bezogen auf DIESE Node
	index int
	// portID: ID des eigenen Ports der ALTEN Node. Bleibt sie über den Neustart gleich (Nodes
	// mit deterministischen IDs, z. B. omp-device-hub), gewinnt sie gegenüber dem Index.
	portID      string
	otherPortID string
}

// MigrateInstance (Kapitel 13 Teil 3) validiert synchron (unbekannte
// Instanz, bereits auf dem Zielhost, noch nicht registriert — alle drei
// sofort dem Aufrufer meldbar) und erfasst die aktuellen Kanten, BEVOR
// irgendetwas verändert wird. Der eigentliche Stop/Start/Reconnect
// läuft danach asynchron im Hintergrund (gleiches Muster wie
// workflows.Service.RestartRole/MigrateRole) — liefert also selbst nur
// "angestoßen", nicht "fertig" zurück, beobachtbar per SSE/Poll auf
// /api/v1/instances bzw. /api/v1/graph.
func (s *Service) MigrateInstance(ctx context.Context, oldInstanceID, targetHostID string) error {
	inst, edges, carry, err := s.prepareMigration(ctx, oldInstanceID, targetHostID, false)
	if err != nil {
		return err
	}
	safego.Go("instancemigrate.migrate", func() {
		_ = s.migrate(inst, targetHostID, edges, carry, false)
	})
	return nil
}

// MigrateInstanceSync ist MigrateInstance, wartet aber auf das Ergebnis (Host-Wartung: der Fortschritt je Instanz
// wird gemeldet). Ein Fehler heißt: die alte Instanz läuft unverändert weiter.
func (s *Service) MigrateInstanceSync(ctx context.Context, oldInstanceID, targetHostID string) error {
	inst, edges, carry, err := s.prepareMigration(ctx, oldInstanceID, targetHostID, false)
	if err != nil {
		return err
	}
	return s.migrate(inst, targetHostID, edges, carry, false)
}

// RelocateLost zieht eine Instanz um, deren Host ausgefallen ist (Kapitel 100, Host-Ausfall eigenständiger Instanzen;
// Aufruf aus workflows.checkLostHosts). Wie MigrateInstanceSync, aber ohne Zugriff auf die alte Instanz: ihr eigener
// Zustand und ihre Parameter sind nicht mehr lesbar (die Instanz startet mit Standardwerten, Instanz-Optionen und
// Kanten wandern mit), und ihr Stop bleibt beim Launcher vorgemerkt, bis der Host wieder Telemetrie sendet
// (launcher.RetryPendingStops) — die Abgrenzung gegen eine Doppelsendung. Ist der alte Node schon aus der Registry,
// entfallen die Kanten (nichts zu erfassen).
func (s *Service) RelocateLost(ctx context.Context, oldInstanceID, targetHostID string) error {
	inst, edges, carry, err := s.prepareMigration(ctx, oldInstanceID, targetHostID, true)
	if err != nil {
		return err
	}
	return s.migrate(inst, targetHostID, edges, carry, true)
}

// prepareMigration prüft alles, was sich vor dem ersten Seiteneffekt prüfen lässt, und erfasst Kanten und Zustand.
func (s *Service) prepareMigration(ctx context.Context, oldInstanceID, targetHostID string, lost bool) (launcher.Instance, []edgeRef, carried, error) {
	inst, ok := s.launcher.Get(oldInstanceID)
	if !ok {
		return inst, nil, carried{}, fmt.Errorf("%w: %q", ErrUnknownInstance, oldInstanceID)
	}
	if inst.HostID == targetHostID {
		return inst, nil, carried{}, fmt.Errorf("%w: %q", ErrSameHost, oldInstanceID)
	}
	if s.roles != nil {
		if wfID, role, isRole := s.roles.FindRoleForInstance(oldInstanceID); isRole {
			return inst, nil, carried{}, fmt.Errorf("%w (workflow %s, role %s)", ErrWorkflowRole, wfID, role)
		}
	}
	oldNode, ok := s.findNodeByInstance(oldInstanceID)
	if !ok {
		if lost {
			return inst, nil, carried{}, nil
		}
		return inst, nil, carried{}, fmt.Errorf("%w: %q", ErrNotRegistered, oldInstanceID)
	}
	g := s.graph.Graph(ctx)
	if ll, ok := s.launcher.(interface{ List() []launcher.Instance }); ok {
		instHost := map[string]string{}
		for _, in := range ll.List() {
			instHost[in.ID] = in.HostID
		}
		if peer, bad := workflows.MXLPeerConflict(s.nodes.List(), g.Edges, instHost, oldNode.ID, targetHostID); bad {
			return inst, nil, carried{}, fmt.Errorf("%w: %s", ErrMXLPeer, peer)
		}
	}
	return inst, s.captureEdges(ctx, oldNode), s.captureCarried(oldNode, !lost), nil
}

// migrate zieht eine eigenständige Instanz make-before-break auf den Zielhost um (Nutzerforderung
// 2026-11-02): die NEUE Instanz startet und registriert sich, während die alte weiterläuft; der Zustand
// der alten wird erst dann frisch abgenommen, die Kanten werden auf die neue umgeschaltet, die Verbraucher
// (Viewer, Bild-/Tonmischer) übernehmen die neue Quelle, und ERST ZULETZT wird die alte gestoppt. Scheitert
// der Start oder die Registrierung auf dem Zielhost, bleibt die alte Instanz unberührt (kein Rücksprung
// nötig, kein Signalausfall).
func (s *Service) migrate(inst launcher.Instance, targetHostID string, edges []edgeRef, carry carried, lost bool) error {
	oldInstanceID, nodeType := inst.ID, inst.Type

	newInst, err := s.launcher.StartPinned(nodeType, inst.Version, targetHostID, inst.Label, inst.ExtraEnv, oldInstanceID, "")
	if err != nil {
		slog.Warn("instancemigrate: Start auf dem Zielhost gescheitert — alte Instanz läuft unverändert weiter", "instance", oldInstanceID, "type", nodeType, "targetHost", targetHostID, "error", err)
		return fmt.Errorf("start on target host: %w", err)
	}
	regCtx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	newNode, err := s.awaitRegistration(regCtx, newInst.ID)
	cancel()
	if err != nil {
		slog.Warn("instancemigrate: neue Instanz registriert sich nicht — alte läuft unverändert weiter", "instance", oldInstanceID, "newInstance", newInst.ID, "error", err)
		_ = s.launcher.Stop(newInst.ID)
		return err
	}

	// Zustand der alten Instanz JETZT noch einmal abnehmen: sie lief während des Starts weiter.
	oldNode, haveOld := s.findNodeByInstance(oldInstanceID)
	if haveOld && !lost {
		carry = s.captureCarried(oldNode, true)
	}
	newNode = s.restoreOwnState(carry, newNode)
	newNode = s.awaitEdgePorts(newNode, edges)
	s.reconnect(context.Background(), newNode, edges)
	s.moveOptions(oldInstanceID, newInst.ID)
	s.restoreCarried(carry, newNode)
	if haveOld && !lost { // eine verlorene Quelle sendet nicht mehr: das Warten auf die Verbraucher entfällt
		s.handover(oldNode, newNode)
	}

	// Erst jetzt die alte Instanz beenden (die Kanten laufen bereits über die neue).
	if err := s.launcher.Stop(oldInstanceID); err != nil && !errors.Is(err, launcher.ErrStopDeferred) {
		slog.Error("instancemigrate: alte Instanz ließ sich nach dem Umzug nicht stoppen — beide laufen", "instance", oldInstanceID, "newInstance", newInst.ID, "error", err)
		return nil // umgezogen ist sie
	}
	slog.Info("instancemigrate: migration completed (make-before-break)", "oldInstance", oldInstanceID, "newInstance", newInst.ID, "targetHost", targetHostID)
	return nil
}

// handover meldet den Sender-Tausch allen Nodes mit Node-API (Nodes ohne /handover antworten 404 und werden
// übergangen) und wartet, bis jeder, der eine Übergabe meldet (`handoverPending`), fertig ist — erst dann darf die
// alte Instanz stoppen. Eine eigenständige Instanz hat keine Workflow-Definition, aus der sich ihre Verbraucher
// ablesen ließen (Bild-/Tonmischer entdecken Quellen selbst), deshalb gehen alle Nodes mit.
func (s *Service) handover(oldNode, newNode registry.NodeView) {
	pairs := workflows.SenderPairs(oldNode.Senders, newNode.Senders)
	if len(pairs) == 0 {
		return
	}
	type repl struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	body := struct {
		Replacements []repl `json:"replacements"`
	}{}
	for _, p := range pairs {
		body.Replacements = append(body.Replacements, repl{Old: p[0], New: p[1]})
	}
	raw, _ := json.Marshal(body)
	client := s.client()

	var waiting []string
	for _, n := range s.nodes.List() {
		if n.APIBaseURL == "" || n.ID == oldNode.ID {
			continue
		}
		if n.ID != newNode.ID {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.APIBaseURL+"/handover", bytes.NewReader(raw))
			if err == nil {
				req.Header.Set("Content-Type", "application/json")
				if resp, derr := client.Do(req); derr == nil {
					_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
					resp.Body.Close()
				}
			}
			cancel()
		}
		waiting = append(waiting, n.APIBaseURL)
	}

	deadline := time.Now().Add(handoverWait)
	for _, base := range waiting {
		for {
			pending := false
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/params/handoverPending", nil); err == nil {
				if resp, derr := client.Do(req); derr == nil {
					var out struct {
						Value bool `json:"value"`
					}
					if resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out) == nil {
						pending = out.Value
					}
					resp.Body.Close()
				}
			}
			cancel()
			if !pending {
				break
			}
			if time.Now().After(deadline) {
				slog.Warn("instancemigrate: Übergabe nicht rechtzeitig fertig, fahre fort", "node", base)
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
}

func (s *Service) findNodeByInstance(instanceID string) (registry.NodeView, bool) {
	for _, n := range s.nodes.List() {
		if n.InstanceID == instanceID {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (s *Service) awaitRegistration(ctx context.Context, instanceID string) (registry.NodeView, error) {
	ticker := time.NewTicker(registrationPollInterval)
	defer ticker.Stop()
	for {
		if n, ok := s.findNodeByInstance(instanceID); ok {
			return n, nil
		}
		select {
		case <-ctx.Done():
			return registry.NodeView{}, fmt.Errorf("timed out waiting for registration of instance %s", instanceID)
		case <-ticker.C:
		}
	}
}

// captureEdges liest den AKTUELLEN Graph (vor dem Stop der alten
// Instanz!) und merkt sich für jede Kante, die einen Port von oldNode
// betrifft, dessen Rolle (Seite+Index) plus die ID am anderen Ende.
func (s *Service) captureEdges(ctx context.Context, oldNode registry.NodeView) []edgeRef {
	g := s.graph.Graph(ctx)

	outputIndex := make(map[string]int, len(oldNode.Senders))
	for i, sn := range oldNode.Senders {
		outputIndex[sn.ID] = i
	}
	inputIndex := make(map[string]int, len(oldNode.Receivers))
	for i, r := range oldNode.Receivers {
		inputIndex[r.ID] = i
	}

	var edges []edgeRef
	for _, e := range g.Edges {
		if idx, ok := outputIndex[e.FromSender]; ok {
			edges = append(edges, edgeRef{side: "output", index: idx, portID: e.FromSender, otherPortID: e.ToReceiver})
		}
		if idx, ok := inputIndex[e.ToReceiver]; ok {
			edges = append(edges, edgeRef{side: "input", index: idx, portID: e.ToReceiver, otherPortID: e.FromSender})
		}
	}
	return edges
}

// reconnect wendet edges gegen newNode an — best effort (eine
// fehlgeschlagene Kante bricht die übrigen nicht ab, gleiche Philosophie
// wie workflows.executeMigration/rewireAfterRestart): der Node-Typ
// könnte nach dem Neustart z. B. weniger Ports haben als zuvor
// (Konfigurationsänderung), das darf den restlichen Umzug nicht
// verhindern.
func (s *Service) reconnect(ctx context.Context, newNode registry.NodeView, edges []edgeRef) int {
	connected := 0
	for _, e := range edges {
		var fromSender, toReceiver string
		switch e.side {
		case "output":
			idx := e.index
			for i, sn := range newNode.Senders {
				if e.portID != "" && sn.ID == e.portID {
					idx = i
					break
				}
			}
			if idx >= len(newNode.Senders) {
				slog.Warn("instancemigrate: reconnect skipped, node has fewer senders after restart",
					"node", newNode.ID, "wantIndex", idx, "have", len(newNode.Senders))
				continue
			}
			fromSender, toReceiver = newNode.Senders[idx].ID, e.otherPortID
		case "input":
			idx := e.index
			for i, r := range newNode.Receivers {
				if e.portID != "" && r.ID == e.portID {
					idx = i
					break
				}
			}
			if idx >= len(newNode.Receivers) {
				slog.Warn("instancemigrate: reconnect skipped, node has fewer receivers after restart",
					"node", newNode.ID, "wantIndex", idx, "have", len(newNode.Receivers))
				continue
			}
			fromSender, toReceiver = e.otherPortID, newNode.Receivers[idx].ID
		default:
			continue
		}

		connectCtx, cancel := context.WithTimeout(ctx, registrationTimeout)
		err := s.graph.Connect(connectCtx, fromSender, toReceiver)
		cancel()
		if err != nil {
			slog.Warn("instancemigrate: reconnect failed", "fromSender", fromSender, "toReceiver", toReceiver, "error", err)
			continue
		}
		connected++
	}
	return connected
}

// RestartResult beschreibt den Ausgang von RestartInPlace.
type RestartResult struct {
	OldInstanceID string `json:"oldInstanceId"`
	NewInstanceID string `json:"newInstanceId"`
	// RolledBack: der Start mit der neuen Version scheiterte, die Instanz läuft wieder mit dem
	// bisherigen Binary (NewInstanceID ist dann die zurückgerollte Instanz).
	RolledBack bool `json:"rolledBack,omitempty"`
	// Reconnected: Anzahl wiederhergestellter Kanten.
	Reconnected int `json:"reconnected"`
}

// RestartInPlace startet eine eigenständige Instanz auf DEMSELBEN Host neu — mit der Binary-Version,
// die ein regulärer Start jetzt bekäme (produktive Version) — und stellt ihre Kanten wieder her
// (Kapitel 28 Schritt 3, kontrollierte Migration auf eine andere Version). Synchron.
//
// Sicherheitsnetz: scheitert der Start der neuen Version oder ihre Registrierung, wird sofort
// die alte Version (Pin auf den bisherigen Stand) neu gestartet und verkabelt; der Fehler wird
// trotzdem gemeldet. Instanz-Optionen wandern mit. Ein kurzer Signalausfall ist hier wie beim
// Host-Umzug hinnehmbar (kein Make-before-break für eigenständige Instanzen).
func (s *Service) RestartInPlace(ctx context.Context, oldInstanceID string) (RestartResult, error) {
	inst, ok := s.launcher.Get(oldInstanceID)
	if !ok {
		return RestartResult{}, fmt.Errorf("%w: %q", ErrUnknownInstance, oldInstanceID)
	}
	res := RestartResult{OldInstanceID: oldInstanceID}
	var edges []edgeRef
	var carry carried
	if oldNode, ok := s.findNodeByInstance(oldInstanceID); ok {
		edges = s.captureEdges(ctx, oldNode)
		carry = s.captureCarried(oldNode, true)
	}
	oldPin := inst.NodeVersion
	if oldPin == "" {
		oldPin = launcher.PinInstalled
	}

	if err := s.launcher.Stop(oldInstanceID); err != nil {
		return res, fmt.Errorf("alte Instanz stoppen: %w", err)
	}

	start := func(pin string) (launcher.Instance, registry.NodeView, error) {
		n, err := s.launcher.StartPinned(inst.Type, inst.Version, inst.HostID, inst.Label, inst.ExtraEnv, oldInstanceID, pin)
		if err != nil {
			return n, registry.NodeView{}, err
		}
		rctx, cancel := context.WithTimeout(ctx, registrationTimeout)
		defer cancel()
		node, err := s.awaitRegistration(rctx, n.ID)
		if err != nil {
			_ = s.launcher.Stop(n.ID)
			return n, registry.NodeView{}, err
		}
		return n, node, nil
	}

	newInst, newNode, err := start("")
	if err != nil {
		slog.Warn("instancemigrate: neue Version startet nicht — Rollback", "instance", oldInstanceID, "error", err)
		rb, rbNode, rbErr := start(oldPin)
		if rbErr != nil {
			return res, fmt.Errorf("neue Version fehlgeschlagen (%v) UND Rollback fehlgeschlagen: %w", err, rbErr)
		}
		res.RolledBack, res.NewInstanceID = true, rb.ID
		rbNode = s.restoreOwnState(carry, rbNode)
		rbNode = s.awaitEdgePorts(rbNode, edges)
		res.Reconnected = s.reconnectCounting(ctx, rbNode, edges)
		s.moveOptions(oldInstanceID, rb.ID)
		s.restoreCarried(carry, rbNode)
		return res, fmt.Errorf("neue Version fehlgeschlagen, auf bisherigen Stand zurückgerollt: %w", err)
	}
	res.NewInstanceID = newInst.ID
	newNode = s.restoreOwnState(carry, newNode)
	newNode = s.awaitEdgePorts(newNode, edges)
	res.Reconnected = s.reconnectCounting(ctx, newNode, edges)
	s.moveOptions(oldInstanceID, newInst.ID)
	s.restoreCarried(carry, newNode)
	return res, nil
}

func (s *Service) moveOptions(from, to string) {
	if s.options == nil {
		return
	}
	if err := s.options.MoveInstance(from, to); err != nil {
		slog.Warn("instancemigrate: Instanz-Optionen nicht übertragen", "from", from, "to", to, "error", err)
	}
}

// reconnectCounting wie reconnect, liefert aber die Zahl der Kanten, die der neue Node aufnehmen konnte.
func (s *Service) reconnectCounting(ctx context.Context, newNode registry.NodeView, edges []edgeRef) int {
	return s.reconnect(ctx, newNode, edges)
}

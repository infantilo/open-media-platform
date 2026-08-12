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
// Ablauf: alte Instanz stoppen, eine neue vom selben Node-Typ auf dem
// Zielhost starten, ihre Registrierung abwarten, dann alle Kanten
// wiederherstellen, die die alte Instanz betrafen — Zuordnung über
// Port-ROLLE (Seite + Index in der IS-04-Registrierungsreihenfolge),
// nicht über die IDs selbst, da Sender-/Receiver-IDs bei jedem Neustart
// neu vergeben werden. Kein Make-before-break wie beim Workflow-Pfad:
// eine eigenständige Instanz hat keinen Workflow-Zustand zum
// Übertragen, ein kurzer Signalausfall während des Umzugs ist hier
// hinnehmbar (der Nutzer hat den Umzug per Bestätigungsdialog bewusst
// ausgelöst).
package instancemigrate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
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
	Stop(id string) error
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
}

func NewService(nodes NodeLister, launcherSvc LauncherService, graphSvc GraphService) *Service {
	return &Service{nodes: nodes, launcher: launcherSvc, graph: graphSvc}
}

// edgeRef hält fest, über welchen Port (Seite+Index, NICHT die ID) der
// ALTEN Node eine Kante lief, und die (über den Neustart hinweg
// stabile) ID am jeweils ANDEREN Ende.
type edgeRef struct {
	side        string // "input" oder "output", bezogen auf DIESE Node
	index       int
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
	inst, ok := s.launcher.Get(oldInstanceID)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownInstance, oldInstanceID)
	}
	if inst.HostID == targetHostID {
		return fmt.Errorf("%w: %q", ErrSameHost, oldInstanceID)
	}
	oldNode, ok := s.findNodeByInstance(oldInstanceID)
	if !ok {
		return fmt.Errorf("%w: %q", ErrNotRegistered, oldInstanceID)
	}
	edges := s.captureEdges(ctx, oldNode)

	safego.Go("instancemigrate.migrate", func() {
		s.migrate(oldInstanceID, inst.Type, inst.Label, targetHostID, edges)
	})
	return nil
}

func (s *Service) migrate(oldInstanceID, nodeType, label, targetHostID string, edges []edgeRef) {
	if err := s.launcher.Stop(oldInstanceID); err != nil {
		slog.Warn("instancemigrate: stop old instance failed", "instance", oldInstanceID, "error", err)
		return
	}

	newInst, err := s.launcher.StartLabeled(nodeType, "", targetHostID, label, nil)
	if err != nil {
		slog.Warn("instancemigrate: start on target host failed", "type", nodeType, "targetHost", targetHostID, "error", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	newNode, err := s.awaitRegistration(ctx, newInst.ID)
	cancel()
	if err != nil {
		slog.Warn("instancemigrate: new instance failed to register", "instance", newInst.ID, "error", err)
		return
	}

	s.reconnect(context.Background(), newNode, edges)
	slog.Info("instancemigrate: migration completed", "oldInstance", oldInstanceID, "newInstance", newInst.ID, "targetHost", targetHostID)
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
			edges = append(edges, edgeRef{side: "output", index: idx, otherPortID: e.ToReceiver})
		}
		if idx, ok := inputIndex[e.ToReceiver]; ok {
			edges = append(edges, edgeRef{side: "input", index: idx, otherPortID: e.FromSender})
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
func (s *Service) reconnect(ctx context.Context, newNode registry.NodeView, edges []edgeRef) {
	for _, e := range edges {
		var fromSender, toReceiver string
		switch e.side {
		case "output":
			if e.index >= len(newNode.Senders) {
				slog.Warn("instancemigrate: reconnect skipped, node has fewer senders after restart",
					"node", newNode.ID, "wantIndex", e.index, "have", len(newNode.Senders))
				continue
			}
			fromSender, toReceiver = newNode.Senders[e.index].ID, e.otherPortID
		case "input":
			if e.index >= len(newNode.Receivers) {
				slog.Warn("instancemigrate: reconnect skipped, node has fewer receivers after restart",
					"node", newNode.ID, "wantIndex", e.index, "have", len(newNode.Receivers))
				continue
			}
			fromSender, toReceiver = e.otherPortID, newNode.Receivers[e.index].ID
		default:
			continue
		}

		connectCtx, cancel := context.WithTimeout(ctx, registrationTimeout)
		err := s.graph.Connect(connectCtx, fromSender, toReceiver)
		cancel()
		if err != nil {
			slog.Warn("instancemigrate: reconnect failed", "fromSender", fromSender, "toReceiver", toReceiver, "error", err)
		}
	}
}

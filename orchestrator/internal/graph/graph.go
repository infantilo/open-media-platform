// Package graph liefert die Graph-API des Flow-Editors (UMSETZUNG.md B1):
// eine reine Projektion des Standard-Zustands (IS-04-Registry-Snapshot +
// IS-05-Active-Endpoints der Receiver) — kein eigenes Datenmodell
// (ARCHITECTURE.md §4.5a).
package graph

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// Port ist ein Ein- oder Ausgang einer Kachel (Receiver bzw. Sender).
// Format kommt unverändert aus dem IS-04-Snapshot (registry.SenderView/
// ReceiverView) und erlaubt der UI, inkompatible Ports beim Drag & Drop
// zu erkennen (UMSETZUNG.md B3) — der Orchestrator selbst entscheidet
// nichts über Kompatibilität.
type Port struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Format string `json:"format"`
}

// Node ist eine Kachel im Flow-Editor.
type Node struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Inputs  []Port `json:"inputs"`
	Outputs []Port `json:"outputs"`
	Health  string `json:"health"`
}

// Edge ist eine IS-05-Connection zwischen Sender und Receiver. Die ID
// entspricht der Receiver-ID: ein Receiver hat immer höchstens eine
// aktive Connection, das macht die Receiver-ID zu einer natürlichen,
// eindeutigen Edge-ID ohne zusätzliches Datenmodell.
type Edge struct {
	ID         string `json:"id"`
	FromSender string `json:"fromSender"`
	ToReceiver string `json:"toReceiver"`
	State      string `json:"state"`
}

// Graph ist der Body von GET /api/v1/graph.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

var (
	// ErrUnknownReceiver wird geliefert, wenn keine Node im aktuellen
	// Registry-Snapshot einen Receiver mit der angefragten ID besitzt.
	ErrUnknownReceiver = errors.New("graph: unknown receiver")
	// ErrNodeUnreachable wird geliefert, wenn die Node keine bekannte
	// API-Basis-URL hat (kein "api.endpoints"-Eintrag in ihrem
	// IS-04-Node-Resource).
	ErrNodeUnreachable = errors.New("graph: node has no reachable api endpoint")
	// ErrRoutingLoop wird geliefert, wenn die angefragte Verbindung eine
	// Feedback-Schleife im Node-Signalfluss schließen würde (Node A
	// speist über eine Kette von Kanten am Ende wieder sich selbst).
	ErrRoutingLoop = errors.New("graph: connecting would create a routing loop")
)

// NodeLister liefert den zuletzt bekannten Node-Snapshot (implementiert
// von *registry.Store).
type NodeLister interface {
	List() []registry.NodeView
}

// is05Client ist die von Service genutzte Teilmenge von *is05.Client —
// als Interface gehalten, damit Service-Tests ohne echte HTTP-Aufrufe
// auskommen.
type is05Client interface {
	GetActive(ctx context.Context, baseURL, receiverID string) (is05.ActiveResource, error)
	PatchStaged(ctx context.Context, baseURL, receiverID string, senderID *string, masterEnable bool) error
	PatchSenderStaged(ctx context.Context, baseURL, senderID string, masterEnable bool) error
}

// EventPublisher verteilt ein SSE-Event an alle verbundenen Flow-Editor-
// Clients (implementiert von *sse.Hub). Schließt eine Lücke aus B4: bis
// hierhin lösten nur Node-Inventar-Änderungen ("node.added" etc., siehe
// registry.Poller) ein Neuladen des Graphen im Browser aus — eine Kante,
// die ein anderer Client (oder ein Skript) über die API erzeugt/trennt,
// blieb im eigenen Tab unsichtbar bis zum manuellen Reload. Optional
// (darf nil sein, z. B. in Tests) wie registry.Poller.OnChange.
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Service baut den Graphen und führt IS-05-Verbindungsänderungen aus.
type Service struct {
	nodes  NodeLister
	is05   is05Client
	events EventPublisher
}

// NewService verbindet einen NodeLister mit einem IS-05-Client und
// (optional, darf nil sein) einem EventPublisher für Live-Updates.
func NewService(nodes NodeLister, client is05Client, events EventPublisher) *Service {
	return &Service{nodes: nodes, is05: client, events: events}
}

// publish sendet ein "edge.added"/"edge.removed"-Event, falls ein
// EventPublisher konfiguriert ist. Der Payload enthält nur die
// Receiver-ID (== Edge-ID) — die UI reagiert ohnehin mit einem vollen
// GET /api/v1/graph (siehe ui/graph/flow-canvas.ts), der Event-Inhalt
// selbst ist nur ein Trigger, keine Datenquelle.
func (s *Service) publish(eventType, receiverID string) {
	if s.events == nil {
		return
	}
	data, err := json.Marshal(map[string]string{"id": receiverID})
	if err != nil {
		return
	}
	s.events.Broadcast(sse.Event{Type: eventType, Data: data})
}

// Graph liefert den kompletten Ist-Zustand: Nodes aus dem Registry-
// Snapshot, Edges aus den IS-05-Active-Endpoints der Receiver.
func (s *Service) Graph(ctx context.Context) Graph {
	views := s.nodes.List()
	return Graph{Nodes: buildNodes(views), Edges: s.buildEdges(ctx, views)}
}

// Connect PATCHt den Receiver toReceiver auf fromSender (sofortige
// Aktivierung) — der eigentliche IS-05-PATCH hinter POST
// /api/v1/graph/edges. Lehnt Verbindungen ab, die eine Feedback-
// Schleife im Node-Signalfluss schließen würden (ErrRoutingLoop):
// generische Prüfung über die bestehenden Kanten, ohne Node-Typ-Wissen
// — konservativ angenommen wird, dass jeder Node mit Ein- und
// Ausgängen seine Ausgänge von seinen Eingängen ableitet.
//
// Schaltet zusätzlich (best-effort) den Sender-Ausgang selbst scharf
// (UMSETZUNG.md C3: "IS-05-Connection-API des Nodes steuert ... Start/
// Stop") — ein Fehler dabei bricht die bereits erfolgreiche Receiver-
// Verbindung nicht ab, da nicht jeder Node eine eigene Sender-seitige
// Connection-API implementiert (z. B. der Mock-Node, Schritt A7/B1).
func (s *Service) Connect(ctx context.Context, fromSender, toReceiver string) error {
	views := s.nodes.List()

	receiverNode, ok := findNodeByReceiver(views, toReceiver)
	if !ok {
		return ErrUnknownReceiver
	}
	if receiverNode.APIBaseURL == "" {
		return ErrNodeUnreachable
	}

	senderNode, senderFound := findNodeByPort(views, fromSender)
	if senderFound {
		if senderNode.ID == receiverNode.ID {
			return ErrRoutingLoop
		}
		signalGraph := buildNodeSignalGraph(views, s.buildEdges(ctx, views))
		if reachable(signalGraph, receiverNode.ID, senderNode.ID) {
			return ErrRoutingLoop
		}
	}

	sender := fromSender
	if err := s.is05.PatchStaged(ctx, receiverNode.APIBaseURL, toReceiver, &sender, true); err != nil {
		return err
	}

	if senderFound && senderNode.APIBaseURL != "" {
		if err := s.is05.PatchSenderStaged(ctx, senderNode.APIBaseURL, fromSender, true); err != nil {
			slog.Warn("is05 PatchSenderStaged failed (node may not implement a sender-side connection API)",
				"sender", fromSender, "error", err)
		}
	}

	s.publish("edge.added", toReceiver)
	return nil
}

// Disconnect trennt receiverID — der IS-05-PATCH hinter DELETE
// /api/v1/graph/edges/<id>. Schaltet (best-effort, siehe Connect) auch
// den zuvor verbundenen Sender wieder ab.
func (s *Service) Disconnect(ctx context.Context, receiverID string) error {
	views := s.nodes.List()

	node, ok := findNodeByReceiver(views, receiverID)
	if !ok {
		return ErrUnknownReceiver
	}
	if node.APIBaseURL == "" {
		return ErrNodeUnreachable
	}

	previousSenderID := ""
	if active, err := s.is05.GetActive(ctx, node.APIBaseURL, receiverID); err == nil && active.SenderID != nil {
		previousSenderID = *active.SenderID
	}

	if err := s.is05.PatchStaged(ctx, node.APIBaseURL, receiverID, nil, false); err != nil {
		return err
	}

	if previousSenderID != "" {
		if senderNode, ok := findNodeByPort(views, previousSenderID); ok && senderNode.APIBaseURL != "" {
			if err := s.is05.PatchSenderStaged(ctx, senderNode.APIBaseURL, previousSenderID, false); err != nil {
				slog.Warn("is05 PatchSenderStaged failed on disconnect (node may not implement a sender-side connection API)",
					"sender", previousSenderID, "error", err)
			}
		}
	}

	s.publish("edge.removed", receiverID)
	return nil
}

func (s *Service) buildEdges(ctx context.Context, views []registry.NodeView) []Edge {
	edges := []Edge{}
	for _, v := range views {
		if v.APIBaseURL == "" {
			continue
		}
		for _, r := range v.Receivers {
			active, err := s.is05.GetActive(ctx, v.APIBaseURL, r.ID)
			if err != nil {
				slog.Warn("is05 GetActive failed", "receiver", r.ID, "error", err)
				continue
			}
			if active.SenderID != nil && active.MasterEnable {
				edges = append(edges, Edge{
					ID:         r.ID,
					FromSender: *active.SenderID,
					ToReceiver: r.ID,
					State:      "active",
				})
			}
		}
	}
	return edges
}

// buildNodes ordnet Devices/Senders/Receivers eines NodeView den
// Ein-/Ausgangs-Ports einer Kachel zu. Reine Funktion, kein I/O —
// unabhängig von buildEdges testbar.
func buildNodes(views []registry.NodeView) []Node {
	nodes := make([]Node, 0, len(views))
	for _, v := range views {
		n := Node{ID: v.ID, Label: v.Label, Inputs: []Port{}, Outputs: []Port{}, Health: health(v)}
		for _, r := range v.Receivers {
			n.Inputs = append(n.Inputs, Port{ID: r.ID, Label: r.Label, Format: r.Format})
		}
		for _, sn := range v.Senders {
			n.Outputs = append(n.Outputs, Port{ID: sn.ID, Label: sn.Label, Format: sn.Format})
		}
		nodes = append(nodes, n)
	}
	return nodes
}

func health(v registry.NodeView) string {
	if v.Online {
		return "ok"
	}
	return "offline"
}

func findNodeByReceiver(views []registry.NodeView, receiverID string) (registry.NodeView, bool) {
	for _, v := range views {
		for _, r := range v.Receivers {
			if r.ID == receiverID {
				return v, true
			}
		}
	}
	return registry.NodeView{}, false
}

// findNodeByPort findet die Node, zu der ein Port (Sender- oder
// Receiver-ID) gehört — genutzt für die generische Loop-Erkennung, die
// beide Portarten gleich behandelt.
func findNodeByPort(views []registry.NodeView, portID string) (registry.NodeView, bool) {
	for _, v := range views {
		for _, r := range v.Receivers {
			if r.ID == portID {
				return v, true
			}
		}
		for _, sn := range v.Senders {
			if sn.ID == portID {
				return v, true
			}
		}
	}
	return registry.NodeView{}, false
}

// buildNodeSignalGraph bildet ab, welche Nodes über bestehende Kanten
// Signale an welche anderen Nodes weiterreichen (Sender-Node ->
// Receiver-Node). Reine Funktion auf bereits bekannten Views/Edges,
// unabhängig von buildEdges' IS-05-Aufrufen testbar.
func buildNodeSignalGraph(views []registry.NodeView, edges []Edge) map[string][]string {
	g := make(map[string][]string)
	for _, e := range edges {
		senderNode, ok := findNodeByPort(views, e.FromSender)
		if !ok {
			continue
		}
		receiverNode, ok := findNodeByPort(views, e.ToReceiver)
		if !ok {
			continue
		}
		g[senderNode.ID] = append(g[senderNode.ID], receiverNode.ID)
	}
	return g
}

// reachable prüft per Breitensuche, ob to von from aus über g erreichbar
// ist (inklusive from == to).
func reachable(g map[string][]string, from, to string) bool {
	if from == to {
		return true
	}
	visited := map[string]bool{from: true}
	queue := []string{from}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, next := range g[current] {
			if next == to {
				return true
			}
			if !visited[next] {
				visited[next] = true
				queue = append(queue, next)
			}
		}
	}
	return false
}

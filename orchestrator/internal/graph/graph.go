// Package graph liefert die Graph-API des Flow-Editors (UMSETZUNG.md B1):
// eine reine Projektion des Standard-Zustands (IS-04-Registry-Snapshot +
// IS-05-Active-Endpoints der Receiver) — kein eigenes Datenmodell
// (ARCHITECTURE.md §4.5a).
package graph

import (
	"context"
	"errors"
	"log/slog"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
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
}

// Service baut den Graphen und führt IS-05-Verbindungsänderungen aus.
type Service struct {
	nodes NodeLister
	is05  is05Client
}

// NewService verbindet einen NodeLister mit einem IS-05-Client.
func NewService(nodes NodeLister, client is05Client) *Service {
	return &Service{nodes: nodes, is05: client}
}

// Graph liefert den kompletten Ist-Zustand: Nodes aus dem Registry-
// Snapshot, Edges aus den IS-05-Active-Endpoints der Receiver.
func (s *Service) Graph(ctx context.Context) Graph {
	views := s.nodes.List()
	return Graph{Nodes: buildNodes(views), Edges: s.buildEdges(ctx, views)}
}

// Connect PATCHt den Receiver toReceiver auf fromSender (sofortige
// Aktivierung) — der eigentliche IS-05-PATCH hinter POST
// /api/v1/graph/edges.
func (s *Service) Connect(ctx context.Context, fromSender, toReceiver string) error {
	node, ok := findNodeByReceiver(s.nodes.List(), toReceiver)
	if !ok {
		return ErrUnknownReceiver
	}
	if node.APIBaseURL == "" {
		return ErrNodeUnreachable
	}
	sender := fromSender
	return s.is05.PatchStaged(ctx, node.APIBaseURL, toReceiver, &sender, true)
}

// Disconnect trennt receiverID — der IS-05-PATCH hinter DELETE
// /api/v1/graph/edges/<id>.
func (s *Service) Disconnect(ctx context.Context, receiverID string) error {
	node, ok := findNodeByReceiver(s.nodes.List(), receiverID)
	if !ok {
		return ErrUnknownReceiver
	}
	if node.APIBaseURL == "" {
		return ErrNodeUnreachable
	}
	return s.is05.PatchStaged(ctx, node.APIBaseURL, receiverID, nil, false)
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

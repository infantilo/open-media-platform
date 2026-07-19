package snapshots

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// NodeLister liefert den zuletzt bekannten Node-Snapshot (implementiert
// von *registry.Store).
type NodeLister interface {
	List() []registry.NodeView
}

// GraphService ist die von Service genutzte Teilmenge von *graph.Service.
type GraphService interface {
	Graph(ctx context.Context) graph.Graph
	Connect(ctx context.Context, fromSender, toReceiver string) error
}

// snapshotStore ist die von Service genutzte Teilmenge von *Store —
// als Interface gehalten, damit Service-Tests ohne echtes Dateisystem
// auskommen.
type snapshotStore interface {
	Put(snap Snapshot) error
	Get(id string) (Snapshot, error)
	List() ([]Snapshot, error)
}

// Service erfasst und stellt Szenen wieder her (UMSETZUNG.md B7).
type Service struct {
	nodes  NodeLister
	graph  GraphService
	store  snapshotStore
	client nodeClient
}

// NewService verbindet einen NodeLister, den Graph-Service und einen
// Postgres-Store (UMSETZUNG.md D1) zu einem Snapshot-Service. httpClient
// ist der (ggf. mTLS-fähige, UMSETZUNG.md D3) Client für Node-Aufrufe —
// nil bedeutet http.DefaultClient.
func NewService(nodes NodeLister, graphSvc GraphService, store *Store, httpClient *http.Client) *Service {
	return &Service{nodes: nodes, graph: graphSvc, store: store, client: newHTTPNodeClient(httpClient)}
}

// Create erfasst den Ist-Zustand und speichert ihn als neuen Snapshot.
// `nodeIDs` leer: klassische, workflow-weite Szene (Kanten + alle
// schreibbaren Parameterwerte aller erreichbaren Nodes, unverändertes
// B7-Verhalten). `nodeIDs` nicht leer: ein "Node-Preset" (§4.6 Punkt 4)
// — nur die Parameter der genannten Nodes, keine Kanten (ein Preset ist
// Node-interner Zustand).
func (s *Service) Create(ctx context.Context, label string, nodeIDs []string) (Snapshot, error) {
	scoped := len(nodeIDs) > 0
	scope := make(map[string]bool, len(nodeIDs))
	for _, id := range nodeIDs {
		scope[id] = true
	}

	edges := []Edge{}
	if !scoped {
		g := s.graph.Graph(ctx)
		edges = make([]Edge, len(g.Edges))
		for i, e := range g.Edges {
			edges[i] = Edge{FromSender: e.FromSender, ToReceiver: e.ToReceiver}
		}
	}

	var params []ParamValue
	var states []NodeState
	for _, node := range s.nodes.List() {
		if node.APIBaseURL == "" {
			continue
		}
		if scoped && !scope[node.ID] {
			continue
		}

		// Node-eigener Vollzustand (docs/decisions.md Nachtrag 40) hat
		// Vorrang: Nodes wie omp-audio-mixer/omp-video-mixer-me erklären
		// ausnahmslos alle Parameter readonly:true, die Schleife unten
		// würde für sie nichts erfassen. `ok==false` (404, kein Fehler)
		// heißt "Node kennt /state nicht" — dann normal weiter mit der
		// generischen Parametererfassung.
		state, ok, err := s.client.GetState(ctx, node.APIBaseURL)
		if err != nil {
			slog.Warn("snapshot: failed to fetch node state", "node", node.ID, "error", err)
			continue
		}
		if ok {
			states = append(states, NodeState{NodeID: node.ID, State: state})
			continue
		}

		names, err := s.client.GetWritableParams(ctx, node.APIBaseURL)
		if err != nil {
			slog.Warn("snapshot: failed to fetch descriptor", "node", node.ID, "error", err)
			continue
		}
		for _, name := range names {
			value, err := s.client.GetParam(ctx, node.APIBaseURL, name)
			if err != nil {
				slog.Warn("snapshot: failed to fetch param", "node", node.ID, "param", name, "error", err)
				continue
			}
			params = append(params, ParamValue{NodeID: node.ID, Name: name, Value: value})
		}
	}

	id, err := newID()
	if err != nil {
		return Snapshot{}, err
	}

	snap := Snapshot{
		ID:        id,
		Label:     label,
		CreatedAt: time.Now(),
		Edges:     edges,
		Params:    params,
		States:    states,
		NodeIDs:   nodeIDs,
	}
	if err := s.store.Put(snap); err != nil {
		return Snapshot{}, err
	}
	return snap, nil
}

// List liefert alle gespeicherten Snapshots.
func (s *Service) List() ([]Snapshot, error) {
	return s.store.List()
}

// Apply stellt einen Snapshot wieder her: zuerst alle Parameterwerte,
// danach alle Kanten (UMSETZUNG.md B7: "Reihenfolge: Parameter, dann
// Kanten"). Fehler werden gesammelt statt beim ersten Fehler abzubrechen.
func (s *Service) Apply(ctx context.Context, id string) (ApplyResult, error) {
	snap, err := s.store.Get(id)
	if err != nil {
		return ApplyResult{}, err
	}

	errs := []string{}

	for _, s_ := range snap.States {
		node, ok := s.findNode(s_.NodeID)
		if !ok || node.APIBaseURL == "" {
			errs = append(errs, fmt.Sprintf("state on node %s: node unreachable", s_.NodeID))
			continue
		}
		applied, err := s.client.ApplyState(ctx, node.APIBaseURL, s_.State)
		if err != nil {
			errs = append(errs, fmt.Sprintf("state on node %s: %v", s_.NodeID, err))
			continue
		}
		if !applied {
			errs = append(errs, fmt.Sprintf("state on node %s: node no longer supports /state", s_.NodeID))
		}
	}

	for _, p := range snap.Params {
		node, ok := s.findNode(p.NodeID)
		if !ok || node.APIBaseURL == "" {
			errs = append(errs, fmt.Sprintf("param %s: node %s unreachable", p.Name, p.NodeID))
			continue
		}
		if err := s.client.PatchParam(ctx, node.APIBaseURL, p.Name, p.Value); err != nil {
			errs = append(errs, fmt.Sprintf("param %s on node %s: %v", p.Name, p.NodeID, err))
		}
	}

	for _, e := range snap.Edges {
		if err := s.graph.Connect(ctx, e.FromSender, e.ToReceiver); err != nil {
			errs = append(errs, fmt.Sprintf("edge %s -> %s: %v", e.FromSender, e.ToReceiver, err))
		}
	}

	return ApplyResult{Errors: errs}, nil
}

func (s *Service) findNode(nodeID string) (registry.NodeView, bool) {
	for _, n := range s.nodes.List() {
		if n.ID == nodeID {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

package workflows

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// validateInterface prüft die Schnittstelle (Kapitel 88): Namen nicht leer und je Seite eindeutig, mindestens
// ein Mitglied, jedes Mitglied verweist auf eine vorhandene Rolle.
func validateInterface(ifc *Interface, roles map[string]string) error {
	if ifc == nil {
		return nil
	}
	check := func(side string, ports []InterfacePort) error {
		seen := map[string]bool{}
		for _, p := range ports {
			name := strings.TrimSpace(p.Name)
			if name == "" {
				return fmt.Errorf("%w: interface %s needs a name", ErrValidation, side)
			}
			if seen[name] {
				return fmt.Errorf("%w: interface %s %q is defined twice", ErrValidation, side, name)
			}
			seen[name] = true
			if p.Feed != nil && (side != "input" || p.Feed.WorkflowID == "" || p.Feed.Output == "") {
				return fmt.Errorf("%w: interface %s %q: feed only allowed on inputs and needs workflowId and output", ErrValidation, side, name)
			}
			if len(p.Members) == 0 {
				return fmt.Errorf("%w: interface %s %q has no members", ErrValidation, side, name)
			}
			for _, m := range p.Members {
				if _, ok := roles[m.Role]; !ok {
					return fmt.Errorf("%w: interface %s %q references unknown role %q", ErrValidation, side, name, m.Role)
				}
			}
		}
		return nil
	}
	if err := check("output", ifc.Outputs); err != nil {
		return err
	}
	return check("input", ifc.Inputs)
}

// ResolvedMember ist ein aufgelöstes Mitglied: PortID ist die aktuelle IS-04-Sender- bzw. -Empfänger-ID.
type ResolvedMember struct {
	Role      string `json:"role"`
	Port      string `json:"port,omitempty"`
	PortID    string `json:"portId,omitempty"`
	NodeID    string `json:"nodeId,omitempty"`
	Format    string `json:"format,omitempty"`
	Available bool   `json:"available"`
}

// ResolvedPort ist ein Ausgang/Eingang mit aufgelösten Mitgliedern. Available gilt nur, wenn ALLE Mitglieder
// verfügbar sind (ein Ausgang aus Bild und Ton ist ohne Ton nicht „da“).
type ResolvedPort struct {
	Name      string           `json:"name"`
	Label     string           `json:"label"`
	Available bool             `json:"available"`
	Members   []ResolvedMember `json:"members"`
	// Eingänge: dauerhafte Zuordnung und die Sender, die den Eingang gerade speisen (leer = unbekannt/nicht geschaltet).
	Feed          *InterfaceFeed `json:"feed,omitempty"`
	FeedSenderIDs []string       `json:"feedSenderIds,omitempty"`
}

// ResolvedInterface ist die Antwort von GET /api/v1/workflows/{id}/interface.
type ResolvedInterface struct {
	WorkflowID   string         `json:"workflowId"`
	WorkflowName string         `json:"workflowName"`
	Status       string         `json:"status"`
	Outputs      []ResolvedPort `json:"outputs"`
	Inputs       []ResolvedPort `json:"inputs"`
}

// ResolveInterface löst die Schnittstelle von Workflow id gegen die laufenden Nodes auf. Ein gestoppter
// Workflow liefert dieselben Namen mit Available=false.
func (s *Service) ResolveInterface(id string) (ResolvedInterface, error) {
	wf, err := s.Get(id)
	if err != nil {
		return ResolvedInterface{}, err
	}
	res := resolveInterface(wf, s.nodeForRole)
	for i := range res.Inputs {
		in := &res.Inputs[i]
		if p := findInterfacePort(wf.Definition.Interface, "inputs", in.Name); p != nil && p.Feed != nil {
			in.Feed = p.Feed
			for _, snd := range s.feedSenders(*p.Feed) {
				in.FeedSenderIDs = append(in.FeedSenderIDs, snd.ID)
			}
		} else if ids := s.volatileFeed(id, in.Name); len(ids) > 0 {
			in.FeedSenderIDs = ids
		}
	}
	return res, nil
}

func findInterfacePort(ifc *Interface, side, name string) *InterfacePort {
	if ifc == nil {
		return nil
	}
	ports := ifc.Outputs
	if side == "inputs" {
		ports = ifc.Inputs
	}
	for i := range ports {
		if ports[i].Name == name {
			return &ports[i]
		}
	}
	return nil
}

// feedSenders löst den Ausgang des Quell-Workflows zu den aktuellen Sendern auf (leer, wenn er nicht läuft).
func (s *Service) feedSenders(f InterfaceFeed) []registry.SenderView {
	src, err := s.store.Get(f.WorkflowID)
	if err != nil || src.Status != StatusStarted {
		return nil
	}
	var ids []string
	for _, o := range resolveInterface(src, s.nodeForRole).Outputs {
		if o.Name != f.Output {
			continue
		}
		for _, m := range o.Members {
			if m.Available && m.PortID != "" {
				ids = append(ids, m.PortID)
			}
		}
	}
	return s.sendersByID(ids)
}

func (s *Service) volatileFeed(wfID, input string) []string {
	s.feedMu.Lock()
	defer s.feedMu.Unlock()
	return append([]string(nil), s.volatileFeeds[wfID+"\x00"+input]...)
}

func (s *Service) setVolatileFeed(wfID, input string, ids []string) {
	s.feedMu.Lock()
	defer s.feedMu.Unlock()
	if s.volatileFeeds == nil {
		s.volatileFeeds = map[string][]string{}
	}
	s.volatileFeeds[wfID+"\x00"+input] = append([]string(nil), ids...)
}

func resolveInterface(wf Workflow, nodeForRole func(Workflow, string) (registry.NodeView, bool)) ResolvedInterface {
	out := ResolvedInterface{
		WorkflowID: wf.ID, WorkflowName: wf.Name, Status: wf.Status,
		Outputs: []ResolvedPort{}, Inputs: []ResolvedPort{},
	}
	ifc := wf.Definition.Interface
	if ifc == nil {
		return out
	}
	resolve := func(ports []InterfacePort, output bool) []ResolvedPort {
		res := make([]ResolvedPort, 0, len(ports))
		for _, p := range ports {
			rp := ResolvedPort{Name: p.Name, Label: p.Label, Available: true, Members: []ResolvedMember{}}
			if rp.Label == "" {
				rp.Label = p.Name
			}
			for _, m := range p.Members {
				rm := ResolvedMember{Role: m.Role, Port: m.Port}
				if node, ok := nodeForRole(wf, m.Role); ok && node.Online {
					rm.NodeID = node.ID
					if output && m.Port == "" {
						// Ohne Port-Angabe gehören alle Sender der Rolle zum Ausgang (z. B. Bild + Ton einer Quelle), ohne
						// die Lowres-Begleiter, die nur der Vorschau dienen.
						expanded := false
						for _, snd := range node.Senders {
							if isLowresCompanion(snd.Label) {
								continue
							}
							expanded = true
							rp.Members = append(rp.Members, ResolvedMember{
								Role: m.Role, Port: portName(snd.Label, node.Label), PortID: snd.ID, NodeID: node.ID,
								Format: snd.Format, Available: true,
							})
						}
						if expanded {
							continue
						}
					} else if output {
						if snd, ok := findSender(node, m.Port, ""); ok {
							rm.PortID, rm.Format, rm.Available = snd.ID, snd.Format, true
						}
					} else if rcv, ok := findReceiver(node, m.Port); ok {
						rm.PortID, rm.Format, rm.Available = rcv.ID, rcv.Format, true
					}
				}
				if !rm.Available {
					rp.Available = false
				}
				rp.Members = append(rp.Members, rm)
			}
			res = append(res, rp)
		}
		return res
	}
	out.Outputs = resolve(ifc.Outputs, true)
	out.Inputs = resolve(ifc.Inputs, false)
	return out
}

// ConnectedMember beschreibt, was beim Schalten einer Quelle auf einen Workflow-Eingang mit einem Mitglied geschah.
type ConnectedMember struct {
	Role       string `json:"role"`
	Port       string `json:"port,omitempty"`
	Action     string `json:"action"` // "connect" (IS-05-Verbindung) | "pin" (Quelle im Mischer/Umschalter angeheftet)
	SenderID   string `json:"senderId,omitempty"`
	ReceiverID string `json:"receiverId,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ConnectInput schaltet Quellen auf den Workflow-Eingang `input` (Kapitel 88): Jedes Mitglied bekommt den passenden
// Sender (nach Medienart). Mitglieder mit Empfänger werden per IS-05 verbunden. Mitglieder ohne Empfänger (Mischer/
// Umschalter: Eingänge sind dort angeheftete Quellen) heften die erste Bild-Quelle an. Der Workflow muss laufen.
// feed != nil speichert zusätzlich die dauerhafte Zuordnung (Quelle = Workflow-Ausgang); feed == nil hebt eine
// frühere Zuordnung auf, weil der Eingang jetzt von Hand umgeschaltet wurde.
func (s *Service) ConnectInput(ctx context.Context, id, input string, senderIDs []string, feed *InterfaceFeed) ([]ConnectedMember, error) {
	wf, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if wf.Status != StatusStarted {
		return nil, ErrNotRunning
	}
	port := findInterfacePort(wf.Definition.Interface, "inputs", input)
	if port == nil {
		return nil, fmt.Errorf("%w: workflow has no input %q", ErrValidation, input)
	}
	senders := s.sendersByID(senderIDs)
	if len(senders) == 0 {
		return nil, fmt.Errorf("%w: none of the given senders is registered", ErrValidation)
	}
	out, err := s.connectInputMembers(ctx, wf, *port, senders)
	if err != nil {
		return out, err
	}
	s.setVolatileFeed(id, input, senderIDs)
	if (feed == nil) != (port.Feed == nil) || (feed != nil && *feed != *port.Feed) {
		port.Feed = feed
		wf.UpdatedAt = time.Now()
		if err := s.store.Put(wf); err != nil {
			return out, err
		}
		s.publish(wf)
	}
	return out, nil
}

func (s *Service) connectInputMembers(ctx context.Context, wf Workflow, port InterfacePort, senders []registry.SenderView) ([]ConnectedMember, error) {
	var out []ConnectedMember
	okCount := 0
	for _, m := range port.Members {
		res := ConnectedMember{Role: m.Role, Port: m.Port}
		node, found := s.nodeForRole(wf, m.Role)
		if !found {
			res.Action, res.Error = "connect", "role not running"
			out = append(out, res)
			continue
		}
		if len(node.Receivers) > 0 {
			res.Action = "connect"
			rcv, ok := findReceiver(node, m.Port)
			if !ok {
				res.Error = "no such receiver"
			} else if snd, ok := firstWithFormat(senders, rcv.Format); !ok {
				res.Error = "no sender with matching format"
			} else if err := s.graph.Connect(ctx, snd.ID, rcv.ID); err != nil {
				res.Error = err.Error()
			} else {
				res.SenderID, res.ReceiverID = snd.ID, rcv.ID
			}
		} else if _, cross := crosspointByNodeType[roleNodeType(wf, m.Role)]; cross {
			res.Action = "pin"
			snd, ok := firstWithFormat(senders, formatVideo)
			switch {
			case !ok:
				res.Error = "no video sender"
			case node.APIBaseURL == "":
				res.Error = "node has no api endpoint"
			default:
				if err := s.methods.Invoke(ctx, node.APIBaseURL, "crosspoint.pin", map[string]any{"senderId": snd.ID}); err != nil {
					res.Error = err.Error()
				} else {
					res.SenderID = snd.ID
				}
			}
		} else {
			res.Action, res.Error = "connect", "role has neither receivers nor crosspoint"
		}
		if res.Error == "" {
			okCount++
		}
		out = append(out, res)
	}
	if okCount == 0 {
		msg := "nothing could be connected"
		if len(out) > 0 && out[0].Error != "" {
			msg += ": " + out[0].Error
		}
		return out, fmt.Errorf("%w: %s", ErrValidation, msg)
	}
	return out, nil
}

// applyFeeds schaltet die dauerhaft zugeordneten Eingänge (Feed) auf ihre Quell-Ausgänge: die Eingänge von `wf` selbst
// und die aller anderen laufenden Workflows, die von `wf` gespeist werden. Aufruf nach dem Start eines Workflows
// (best effort: fehlt die Quelle noch, passiert beim Start der Quelle dasselbe von der anderen Seite).
func (s *Service) applyFeeds(ctx context.Context, wf Workflow) {
	all, err := s.store.List()
	if err != nil {
		return
	}
	for _, w := range all {
		if w.Status != StatusStarted || w.Definition.Interface == nil {
			continue
		}
		for _, in := range w.Definition.Interface.Inputs {
			if in.Feed == nil || (w.ID != wf.ID && in.Feed.WorkflowID != wf.ID) {
				continue
			}
			senders := s.feedSenders(*in.Feed)
			if len(senders) == 0 {
				continue
			}
			if _, err := s.connectInputMembers(ctx, w, in, senders); err != nil {
				slog.Warn("workflows: interface feed failed", "workflow", w.ID, "input", in.Name, "error", err)
				continue
			}
			ids := make([]string, 0, len(senders))
			for _, snd := range senders {
				ids = append(ids, snd.ID)
			}
			s.setVolatileFeed(w.ID, in.Name, ids)
		}
	}
}

func (s *Service) sendersByID(ids []string) []registry.SenderView {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var out []registry.SenderView
	for _, n := range s.nodes.List() {
		for _, snd := range n.Senders {
			if want[snd.ID] {
				out = append(out, snd)
			}
		}
	}
	return out
}

func firstWithFormat(senders []registry.SenderView, format string) (registry.SenderView, bool) {
	for _, snd := range senders {
		if snd.Format == format {
			return snd, true
		}
	}
	return registry.SenderView{}, false
}

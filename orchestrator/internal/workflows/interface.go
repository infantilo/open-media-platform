package workflows

import (
	"fmt"
	"strings"

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
	return resolveInterface(wf, s.nodeForRole), nil
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
					if output {
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

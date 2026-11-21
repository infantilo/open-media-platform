package main

import "github.com/infantilo/openmediaplatform/orchestrator/internal/authz"

// mcrBinder legt die Workflow-Bindungen der Event-Mitglieder im Rechtespeicher an (nur Ergänzungen; Entzug über die gemerkte Kennung).
type mcrBinder struct{ s *authz.Store }

func (b mcrBinder) BindUser(user, workflowID, verb string) (string, error) {
	r, err := b.s.Create(user, workflowID, authz.AnyNode, authz.Verb(verb))
	return r.ID, err
}

func (b mcrBinder) BindGroup(group, workflowID, verb string) (string, error) {
	r, err := b.s.CreateGroupBinding(group, workflowID, authz.AnyNode, authz.Verb(verb))
	return r.ID, err
}

func (b mcrBinder) Unbind(id string) error { return b.s.Delete(id) }

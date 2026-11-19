// Im laufenden Workflow neu gestartete Instanzen (Flow-Editor, Katalog-Knopf bei geöffnetem Workflow) gehören zu diesem
// Workflow, ohne dass dafür die gespeicherte Definition geändert wird: sie werden als Laufzeit-Rolle eingetragen
// (wf.Runtime). Damit stoppt/pausiert sie der Workflow mit, und der Editor ordnet sie dem Workflow zu statt "Unzugeordnet".
// Dauerhaft wird die Rolle erst durch "Im Workflow speichern" (PUT der Definition mit dieser Rolle); ohne Speichern ist sie
// nach Stop/Start wieder weg.
package workflows

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrInstanceTaken: die Instanz gehört bereits zu einem Workflow.
var ErrInstanceTaken = errors.New("workflows: instance already belongs to a workflow")

// AdoptInstance trägt instanceID (Node nodeID) als Laufzeit-Rolle role in den laufenden Workflow id ein.
func (s *Service) AdoptInstance(id, role, instanceID, nodeID, hostID string) (Workflow, error) {
	role = strings.TrimSpace(role)
	if role == "" || instanceID == "" || nodeID == "" {
		return Workflow{}, fmt.Errorf("%w: role, instanceId and nodeId are required", ErrValidation)
	}
	wf, err := s.store.Get(id)
	if err != nil {
		return Workflow{}, err
	}
	if wf.Status != StatusStarted {
		return Workflow{}, ErrNotRunning
	}
	if _, ok := roleByName(wf, role); ok {
		return Workflow{}, fmt.Errorf("%w: role %q already exists", ErrValidation, role)
	}
	if _, ok := wf.Runtime[role]; ok {
		return Workflow{}, fmt.Errorf("%w: role %q already exists", ErrValidation, role)
	}
	// Die Instanz muss zum angegebenen Node passen (kein Eintragen fremder oder erfundener IDs).
	matched := false
	for _, n := range s.nodes.List() {
		if n.ID == nodeID && n.InstanceID == instanceID {
			matched = true
			break
		}
	}
	if !matched {
		return Workflow{}, fmt.Errorf("%w: node %q is not registered for instance %q", ErrValidation, nodeID, instanceID)
	}
	all, err := s.store.List()
	if err != nil {
		return Workflow{}, err
	}
	for _, other := range all {
		for _, rt := range other.Runtime {
			if rt.InstanceID == instanceID {
				return Workflow{}, ErrInstanceTaken
			}
		}
	}
	if wf.Runtime == nil {
		wf.Runtime = map[string]RoleRuntime{}
	}
	wf.Runtime[role] = RoleRuntime{InstanceID: instanceID, NodeID: nodeID, HostID: hostID}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		return Workflow{}, err
	}
	s.publish(wf)
	return wf, nil
}

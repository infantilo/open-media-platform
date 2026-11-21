package workflows

import (
	"context"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
)

// Reshape ändert die Rollen und Verbindungen eines **laufenden** Workflows, ohne ihn zu stoppen: entfernte Rollen werden einzeln
// gestoppt, neue einzeln gestartet und verdrahtet, geänderte Verbindungen zwischen bestehenden Rollen neu geschaltet. Rollen, die
// bleiben, laufen ununterbrochen weiter. Ausführung im Hintergrund; Rückgabe nach dem Ablegen der neuen Definition.
// (106.13: Leitungen eines Events kommen und gehen, ohne die übrigen zu unterbrechen.)
func (s *Service) Reshape(ctx context.Context, id, name string, def Definition) error {
	if err := validate(def); err != nil {
		return err
	}
	wf, err := s.store.Get(id)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted {
		return ErrNotRunning
	}
	oldRoles := map[string]bool{}
	for _, r := range wf.Definition.Roles {
		oldRoles[r.Name] = true
	}
	newRoles := map[string]bool{}
	var added []string
	for _, r := range def.Roles {
		newRoles[r.Name] = true
		if !oldRoles[r.Name] {
			added = append(added, r.Name)
		}
	}
	var removed []RoleRuntime
	var removedNames []string
	for n := range oldRoles {
		if !newRoles[n] {
			removedNames = append(removedNames, n)
			if rr, ok := wf.Runtime[n]; ok && rr.InstanceID != "" {
				removed = append(removed, rr)
			}
			delete(wf.Runtime, n)
		}
	}
	changed := changedConnections(wf.Definition, def, added)
	if wf.Runtime == nil {
		wf.Runtime = map[string]RoleRuntime{}
	}
	wf.Name, wf.Definition, wf.UpdatedAt = name, def, time.Now()
	if err := s.store.Put(wf); err != nil {
		return err
	}
	if err := s.store.UpdateRuntime(wf); err != nil {
		return err
	}
	s.publish(wf)
	safego.Go("workflows.reshape", func() { s.runReshape(wf, removed, removedNames, added, changed) })
	return nil
}

// changedConnections: Verbindungen der neuen Definition, die es vorher nicht gab und die keine neue Rolle berühren (die der neuen
// Rollen schaltet `runRestartRole` selbst).
func changedConnections(old, nw Definition, added []string) []Connection {
	key := func(c Connection) string {
		return c.FromRole + "\x00" + c.FromSender + "\x00" + c.ToRole + "\x00" + c.ToReceiver
	}
	had := map[string]bool{}
	for _, c := range old.Connections {
		had[key(c)] = true
	}
	isAdded := map[string]bool{}
	for _, a := range added {
		isAdded[a] = true
	}
	var out []Connection
	for _, c := range nw.Connections {
		if !had[key(c)] && !isAdded[c.FromRole] && !isAdded[c.ToRole] {
			out = append(out, c)
		}
	}
	return out
}

func (s *Service) runReshape(wf Workflow, removed []RoleRuntime, removedNames []string, added []string, changed []Connection) {
	for i, rr := range removed {
		if err := s.launcher.Stop(rr.InstanceID); err != nil {
			slog.Warn("workflows: Reshape: Instanz stoppen", "workflow", wf.ID, "instance", rr.InstanceID, "error", err)
		}
		if s.authz != nil {
			_ = s.authz.DeleteInstanceBinding(rr.InstanceID, wf.ID)
		}
		_ = i
	}
	if len(removedNames) > 0 {
		slog.Info("workflows: Reshape: Rollen entfernt", "workflow", wf.ID, "roles", removedNames)
	}
	// neue Rollen nacheinander (die Gegenstelle muss registriert sein, bevor die Verbindung geschaltet wird)
	for _, name := range added {
		cur, err := s.store.Get(wf.ID)
		if err != nil || cur.Status != StatusStarted {
			return
		}
		s.runRestartRole(cur, name)
	}
	cur, err := s.store.Get(wf.ID)
	if err != nil {
		return
	}
	for _, conn := range changed {
		fromNode, ok := s.nodeForRole(cur, conn.FromRole)
		if !ok {
			slog.Warn("workflows: Reshape: Sender nicht bereit", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(cur, conn.ToRole)
		if !ok {
			slog.Warn("workflows: Reshape: Empfänger nicht bereit", "workflow", wf.ID, "connection", conn)
			continue
		}
		cctx, cancel := context.WithTimeout(context.Background(), registrationTimeout.Load())
		err := s.applyConnection(cctx, conn, fromNode, toNode, roleNodeType(cur, conn.ToRole))
		cancel()
		if err != nil {
			slog.Warn("workflows: Reshape: Verbindung schalten", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}
	s.publish(cur)
}

package workflows

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Rollen eines gestoppten Workflows umbenennen (Nutzerwunsch 2026-11-23: alle Node-Namen englisch, auch in bestehenden Workflows).
//
// Ein bloßes Speichern der Definition (`Update`) genügt dafür nicht: Der Rollenname steckt (1) in den Port-Bezeichnungen der
// Nodes („<Rolle> Sender 1“), die Verbindungen und Schnittstelle nennen, (2) in Umgebungswerten, die einen Node über den Namen
// eines anderen finden (z. B. `OMP_RADIO_TARGET_LABEL`), und (3) im gesicherten Rollen-Zustand (Schlüssel und Platzhalter
// `@@omp-role-sender:<Rolle>:<n>`/`@@omp-role-node:<Rolle>`). `Update` verwirft den Zustand bei geänderten Rollen; die
// Umbenennung migriert ihn stattdessen, damit Einstellungen (Mischer, Quellen …) erhalten bleiben.

// RenameRolesInDefinition liefert die Definition mit umbenannten Rollen. `m` bildet alt → neu ab; alle Umbenennungen gelten
// gleichzeitig (Tausch zweier Namen ist möglich). Fehler: unbekannte Rolle, leerer oder doppelter neuer Name.
func RenameRolesInDefinition(def Definition, m map[string]string) (Definition, error) {
	if len(m) == 0 {
		return def, fmt.Errorf("%w: keine Umbenennung angegeben", ErrValidation)
	}
	existing := map[string]bool{}
	for _, r := range def.Roles {
		existing[r.Name] = true
	}
	for old, nw := range m {
		if !existing[old] {
			return def, fmt.Errorf("%w: Rolle %q gibt es nicht", ErrValidation, old)
		}
		if strings.TrimSpace(nw) == "" {
			return def, fmt.Errorf("%w: neuer Name für %q ist leer", ErrValidation, old)
		}
	}
	final := map[string]string{}
	for _, r := range def.Roles {
		n := r.Name
		if v, ok := m[n]; ok {
			n = v
		}
		if prev, dup := final[n]; dup {
			return def, fmt.Errorf("%w: Name %q wäre doppelt (%q und %q)", ErrValidation, n, prev, r.Name)
		}
		final[n] = r.Name
	}
	// Tiefe Kopie über JSON, damit die übergebene Definition unberührt bleibt.
	raw, err := json.Marshal(def)
	if err != nil {
		return def, err
	}
	var out Definition
	if err := json.Unmarshal(raw, &out); err != nil {
		return def, err
	}
	role := func(s string) string {
		if v, ok := m[s]; ok {
			return v
		}
		return s
	}
	// Port-Bezeichnung „<Rolle> <Rest>“: das Präfix der **längsten** passenden alten Rolle ersetzen (Rolle „A“ und „A B“).
	port := func(owner, p string) string {
		old := owner
		if _, ok := m[old]; !ok || !strings.HasPrefix(p, old+" ") {
			return p
		}
		return m[old] + p[len(old):]
	}
	for i := range out.Roles {
		out.Roles[i].Name = role(out.Roles[i].Name)
		for k, v := range out.Roles[i].Env {
			if nv, ok := m[v]; ok {
				out.Roles[i].Env[k] = nv
			}
		}
	}
	for i := range out.Connections {
		c := &out.Connections[i]
		from, to := c.FromRole, c.ToRole
		c.FromSender = port(from, c.FromSender)
		c.ToReceiver = port(to, c.ToReceiver)
		c.FromRole, c.ToRole = role(from), role(to)
	}
	if out.Interface != nil {
		for _, side := range [][]InterfacePort{out.Interface.Outputs, out.Interface.Inputs} {
			for pi := range side {
				for mi := range side[pi].Members {
					mem := &side[pi].Members[mi]
					mem.Port = port(mem.Role, mem.Port)
					mem.Role = role(mem.Role)
				}
			}
		}
	}
	return out, nil
}

// RenameRoleStateJSON schreibt einen gesicherten Rollen-Zustand (Blob eines Nodes) um: die Alias-Platzhalter, die auf eine
// umbenannte Rolle zeigen, schemafrei über den ganzen JSON-Baum.
func RenameRoleStateJSON(raw json.RawMessage, m map[string]string) (json.RawMessage, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw, err
	}
	v = renameAliases(v, m)
	return json.Marshal(v)
}

func renameAliases(v any, m map[string]string) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = renameAliases(val, m)
		}
		return x
	case []any:
		for i := range x {
			x[i] = renameAliases(x[i], m)
		}
		return x
	case string:
		if rest, ok := strings.CutPrefix(x, senderAliasPrefix); ok { // „<Rolle>:<n>“
			if i := strings.LastIndex(rest, ":"); i > 0 {
				if nv, ok := m[rest[:i]]; ok {
					return senderAliasPrefix + nv + rest[i:]
				}
			}
			return x
		}
		if rest, ok := strings.CutPrefix(x, nodeAliasPrefix); ok {
			if nv, ok := m[rest]; ok {
				return nodeAliasPrefix + nv
			}
		}
		return x
	}
	return v
}

// RenameRoleStateMap benennt die Schlüssel einer Zustandsliste (Rolle → Blob) um und schreibt die Blobs um.
func RenameRoleStateMap(states map[string]json.RawMessage, m map[string]string) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(states))
	for role, blob := range states {
		nb, err := RenameRoleStateJSON(blob, m)
		if err != nil {
			nb = blob
		}
		if nv, ok := m[role]; ok {
			role = nv
		}
		out[role] = nb
	}
	return out
}

// RoleRenameHook: ein Modul, das Rollen eines Workflows beim Namen kennt (z. B. Playout-Channels), zieht bei einer Umbenennung nach.
type RoleRenameHook func(workflowID string, m map[string]string) error

// RegisterRoleRenameHook meldet ein solches Modul an.
func (s *Service) RegisterRoleRenameHook(h RoleRenameHook) {
	s.renameHooks = append(s.renameHooks, h)
}

// RenameRoles benennt Rollen eines gestoppten Workflows um (Definition und gesicherter Zustand). Läuft der Workflow, ist
// `ErrNotStopped` die Antwort: laufende Instanzen tragen den alten Namen als Bezeichnung.
func (s *Service) RenameRoles(id string, m map[string]string) (Workflow, error) {
	wf, err := s.store.Get(id)
	if err != nil {
		return Workflow{}, err
	}
	if wf.Status != StatusStopped {
		return Workflow{}, ErrNotStopped
	}
	def, err := RenameRolesInDefinition(wf.Definition, m)
	if err != nil {
		return Workflow{}, err
	}
	if err := validate(def); err != nil {
		return Workflow{}, err
	}
	// Zuerst die Module (schlägt eines fehl, bleibt alles wie es war), dann die Definition; scheitert die, laufen die Module zurück.
	inverse := map[string]string{}
	for old, nw := range m {
		inverse[nw] = old
	}
	for i, h := range s.renameHooks {
		if err := h(id, m); err != nil {
			for _, done := range s.renameHooks[:i] {
				_ = done(id, inverse)
			}
			return Workflow{}, fmt.Errorf("Rollenbezug eines Moduls: %w", err)
		}
	}
	wf.Definition = def
	wf.UpdatedAt = time.Now()
	if err := s.store.Put(wf); err != nil {
		for _, h := range s.renameHooks {
			_ = h(id, inverse)
		}
		return Workflow{}, err
	}
	if err := s.store.RenameRoleState(id, m); err != nil {
		return Workflow{}, fmt.Errorf("Zustand der umbenannten Rollen: %w", err)
	}
	s.publish(wf)
	return wf, nil
}

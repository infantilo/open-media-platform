// Kapitel 100 Punkt 5 — Zustand nach einem Absturz-Neustart.
//
// Startet der Launcher eine abgestürzte Rolle neu, kommt der Node leer hoch. Bewusst wird sein Zustand NICHT von
// selbst wieder eingespielt (docs/decisions.md: der Zustand kann selbst der Absturzgrund sein — das ergäbe eine
// Schleife). Bisher schrieb aber die periodische Sicherung (60 s) den leeren Stand über den letzten guten, der damit
// verloren war. Jetzt wird der gesicherte Stand der Rolle "gehalten": Sicherung und Stop lassen ihn unberührt, bis
// jemand entscheidet —
//
//   - einspielen (RestoreHeldState): der gehaltene Stand geht in den laufenden Node, danach läuft die Sicherung weiter;
//   - verwerfen (DiscardHeldState): der jetzige Stand des Nodes gilt, die nächste Sicherung überschreibt den alten;
//   - im Editor speichern (Pin): wie verwerfen, der jetzige Stand wird festgeschrieben.
//
// Ein Workflow-Stop/-Start spielt den gehaltenen Stand wie jeden gespeicherten Zustand ein (das ist ein bewusster
// Neustart). Der Merker steht im gespeicherten Eintrag und überlebt einen Orchestrator-Neustart.
package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

const heldMarkerKey = "__held"

// ErrNoHeldState: für die Rolle wird kein gesicherter Stand gehalten.
var ErrNoHeldState = errors.New("workflows: no held state for this role")

func hasMarker(raw json.RawMessage, key string) bool {
	if len(raw) == 0 {
		return false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	v, ok := m[key]
	return ok && string(v) == "true"
}

func withMarker(raw json.RawMessage, key string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return raw
	}
	m[key] = json.RawMessage("true")
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

func stripMarker(raw json.RawMessage, key string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return raw
	}
	if _, ok := m[key]; !ok {
		return raw
	}
	delete(m, key)
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

// setStateHold setzt oder löscht den Halte-Merker am gespeicherten Zustand der Rolle. Liefert, ob sich etwas änderte
// (false auch, wenn die Rolle gar keinen gespeicherten Zustand hat — dann gibt es nichts zu schützen).
func (s *Service) setStateHold(wfID, role string, on bool) bool {
	saved, err := s.store.GetRoleState(wfID)
	if err != nil {
		return false
	}
	raw, ok := saved[role]
	if !ok || hasMarker(raw, heldMarkerKey) == on {
		return false
	}
	updated := stripMarker(raw, heldMarkerKey)
	if on {
		updated = withMarker(raw, heldMarkerKey)
	}
	if err := s.store.SetRoleState(wfID, role, updated); err != nil {
		slog.Warn("workflows: failed to persist state hold marker", "workflow", wfID, "role", role, "error", err)
		return false
	}
	s.publishStateHold(wfID, role, on)
	return true
}

func (s *Service) publishStateHold(wfID, role string, held bool) {
	if s.events == nil {
		return
	}
	data, err := json.Marshal(map[string]any{"workflowId": wfID, "role": role, "held": held, "at": time.Now()})
	if err != nil {
		return
	}
	s.events.Broadcast(sse.Event{Type: "workflow.statehold", Data: data})
}

// HeldStates liefert die Rollen des Workflows, deren gesicherter Stand gerade gehalten wird (sortiert).
func (s *Service) HeldStates(workflowID string) ([]string, error) {
	if _, err := s.store.Get(workflowID); err != nil {
		return nil, err
	}
	saved, err := s.store.GetRoleState(workflowID)
	if err != nil {
		return nil, err
	}
	roles := []string{}
	for role, raw := range saved {
		if hasMarker(raw, heldMarkerKey) {
			roles = append(roles, role)
		}
	}
	sort.Strings(roles)
	return roles, nil
}

// RestoreHeldState spielt den gehaltenen Stand in den laufenden Node der Rolle ein (Bedienerentscheidung). Synchron:
// der Aufrufer erfährt, ob der Node ihn angenommen hat.
func (s *Service) RestoreHeldState(ctx context.Context, workflowID, role string) error {
	wf, err := s.store.Get(workflowID)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted {
		return ErrNotRunning
	}
	if _, ok := roleByName(wf, role); !ok {
		return fmt.Errorf("%w: role %q not found", ErrValidation, role)
	}
	saved, err := s.store.GetRoleState(workflowID)
	if err != nil {
		return err
	}
	raw, ok := saved[role]
	if !ok || !hasMarker(raw, heldMarkerKey) {
		return ErrNoHeldState
	}
	// Frisch einspielen, auch wenn derselbe Stand in diesem Lauf schon einmal zugestellt wurde (vor dem Absturz).
	s.unrestoredMu.Lock()
	delete(s.posted, unrestoredKey(workflowID, role))
	s.unrestoredMu.Unlock()
	if err := s.restoreOneRoleStateN(wf, role, raw, 2); err != nil {
		return fmt.Errorf("restore failed: %w", err)
	}
	return nil
}

// DiscardHeldState gibt den gehaltenen Stand auf: der jetzige Stand des Nodes gilt, die Sicherung läuft wieder.
func (s *Service) DiscardHeldState(workflowID, role string) error {
	if _, err := s.store.Get(workflowID); err != nil {
		return err
	}
	if !s.setStateHold(workflowID, role, false) {
		return ErrNoHeldState
	}
	return nil
}

package process

import "fmt"

// Validate prüft ausschließlich die Graph-STRUKTUR einer Definition
// (eindeutige Step-IDs, existierender Start, alle referenzierten
// Folgeschritte existieren) — keine typspezifische Config-Validierung
// (Phase-3-Aufgabe der Runtime, die allein weiß, was z. B. eine
// Condition-Expression syntaktisch gültig macht). Wird vor jedem
// Anlegen einer ProcessVersion aufgerufen (Store.CreateVersion) —
// Korrektheit vor der Persistenz prüfen, nicht erst beim ersten
// Ausführungsversuch scheitern lassen.
func (d Definition) Validate() error {
	if len(d.Steps) == 0 {
		return fmt.Errorf("process: definition has no steps")
	}
	if d.StartStepID == "" {
		return fmt.Errorf("process: startStepId is required")
	}

	ids := make(map[string]struct{}, len(d.Steps))
	for _, s := range d.Steps {
		if s.ID == "" {
			return fmt.Errorf("process: step with empty id")
		}
		if _, dup := ids[s.ID]; dup {
			return fmt.Errorf("process: duplicate step id %q", s.ID)
		}
		if s.Type == "" {
			return fmt.Errorf("process: step %q has no type", s.ID)
		}
		ids[s.ID] = struct{}{}
	}

	if _, ok := ids[d.StartStepID]; !ok {
		return fmt.Errorf("process: startStepId %q references unknown step", d.StartStepID)
	}

	for _, s := range d.Steps {
		for _, next := range s.Next {
			if _, ok := ids[next]; !ok {
				return fmt.Errorf("process: step %q references unknown next step %q", s.ID, next)
			}
		}
		for label, target := range s.Branches {
			if _, ok := ids[target]; !ok {
				return fmt.Errorf("process: step %q branch %q references unknown step %q", s.ID, label, target)
			}
		}
		if s.CompensationStepID != "" {
			if _, ok := ids[s.CompensationStepID]; !ok {
				return fmt.Errorf("process: step %q compensationStepId references unknown step %q", s.ID, s.CompensationStepID)
			}
		}
	}

	return nil
}

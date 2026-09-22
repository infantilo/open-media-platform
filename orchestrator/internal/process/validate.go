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

	hasPredecessor := make(map[string]bool, len(d.Steps))
	for _, s := range d.Steps {
		for _, next := range s.Next {
			if _, ok := ids[next]; !ok {
				return fmt.Errorf("process: step %q references unknown next step %q", s.ID, next)
			}
			hasPredecessor[next] = true
		}
		for label, target := range s.Branches {
			if _, ok := ids[target]; !ok {
				return fmt.Errorf("process: step %q branch %q references unknown step %q", s.ID, label, target)
			}
			hasPredecessor[target] = true
		}
		if s.CompensationStepID != "" {
			if _, ok := ids[s.CompensationStepID]; !ok {
				return fmt.Errorf("process: step %q compensationStepId references unknown step %q", s.ID, s.CompensationStepID)
			}
			// CompensationStepID ist bewusst KEIN normaler Graph-Vorgänger
			// (ein Kompensationsschritt wird nur bei Fehlschlag erreicht,
			// nie über den regulären Next-Pfad) — nicht in hasPredecessor
			// eingetragen, sonst würde die Erreichbarkeitsprüfung unten
			// einen Kompensationsschritt fälschlich als "normal
			// erreichbar" durchwinken, obwohl er nur über den separaten
			// Fehlerpfad der Runtime (Phase 3) angesprungen wird.
		}
	}

	// Erreichbarkeit: jeder Schritt außer dem Start braucht mindestens
	// einen Vorgänger (Next oder Branches) — sonst würde der Runtime-
	// Frontier-Algorithmus (Kapitel 21 Phase 3 Teil 1) einen
	// unerreichbaren Schritt fälschlich sofort als startbereit
	// behandeln ("keine Vorgänger" wird dort synonym mit "ist der
	// Startschritt" gelesen). Echter, beim Runtime-Entwurf gefundener
	// Lücke in dieser bereits bestehenden Validierung.
	for _, s := range d.Steps {
		if s.ID == d.StartStepID {
			continue
		}
		if s.Type == StepTypeCompensation {
			// Kompensationsschritte sind absichtlich nur über
			// CompensationStepID erreichbar (s. o.), nicht über den
			// normalen Graph-Vorgänger-Check.
			continue
		}
		if !hasPredecessor[s.ID] {
			return fmt.Errorf("process: step %q is unreachable (no predecessor and not the start step)", s.ID)
		}
	}

	return nil
}

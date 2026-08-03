// D8 Teil 3 (ARCHITECTURE.md §15.1 Punkt 3, UMSETZUNG.md): nachdem D8
// Teil 2 (latencybudget.go) einen Workflow ablehnt, dessen kürzester Pfad
// LÄNGER als Settings.TargetLatencyFrames wäre, weist dieser Schritt die
// fehlende Differenz für zu KURZE Pfade einem delay-fähigen Node zu
// (setOutputDelay), bevorzugt möglichst spät im Pfad — Ergebnis: jeder
// Pfad eines Workflows verlässt ihn nach exakt targetLatencyFrames.
package workflows

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// delayPlan ordnet jeder Rolle, der eine Verzögerung zugewiesen wurde, die
// Anzahl zusätzlicher Frames zu.
type delayPlan map[string]uint32

// buildDelayCapabilityLookup baut eine nodeType -> supportsDelayCompensation
// Nachschlagetabelle aus dem Katalog (analog buildVideoLatencyLookup,
// latencybudget.go) — Node-Ebene, nicht pro Medienart, s. launcher.
// CatalogLatency.SupportsDelayCompensation-Doku.
func buildDelayCapabilityLookup(catalog []launcher.CatalogEntry) map[string]bool {
	lookup := make(map[string]bool, len(catalog))
	for _, entry := range catalog {
		if entry.Latency != nil && entry.Latency.SupportsDelayCompensation {
			lookup[entry.Type] = true
		}
	}
	return lookup
}

// computeDelayPlan berechnet, welche Rolle wie viele Frames Verzögerung
// zugewiesen bekommt, damit jeder Pfad im Verbindungs-Template exakt
// target Frames erreicht. target==0 (nicht gesetzt) liefert einen leeren
// Plan, keine Prüfung — gleiche Konvention wie checkLatencyBudget. Ein
// Pfad, der target bereits erreicht oder überschreitet, braucht keine
// Zuweisung (>= target: dessen Ablehnung bei Überschreitung ist bereits
// checkLatencyBudgets Aufgabe, hier bewusst nicht dupliziert — dieselbe
// Trennung gilt für unbekannte Latenz, s. unten).
//
// Für jeden zu kurzen Pfad wird die fehlende Differenz der SPÄTESTEN
// delay-fähigen Rolle im Pfad zugewiesen (§15.1 Punkt 3: "bevorzugt
// möglichst spät im Pfad, um Zwischenzustände wie Tally/Preview nicht
// unnötig zu verzögern"). Fehlt eine delay-fähige Rolle auf einem zu
// kurzen Pfad ganz, oder verlangen zwei verschiedene Pfade von derselben
// Rolle unterschiedliche Werte (z. B. ein gemeinsamer Fan-out-Vorfahre auf
// zwei unterschiedlich langen Zweigen), wird das als
// ErrLatencyBudgetInsufficient abgelehnt — kein stiller Teil-Ausgleich,
// dieselbe ehrliche Haltung wie checkLatencyBudget.
func computeDelayPlan(def Definition, catalog []launcher.CatalogEntry) (delayPlan, error) {
	target := def.Settings.TargetLatencyFrames
	if target == 0 {
		return nil, nil
	}

	videoLookup := buildVideoLatencyLookup(catalog)
	paths, err := enumerateLatencyPaths(def, videoLookup)
	if err != nil {
		return nil, err
	}
	delayCapable := buildDelayCapabilityLookup(catalog)

	nodeTypeByRole := make(map[string]string, len(def.Roles))
	for _, r := range def.Roles {
		nodeTypeByRole[r.Name] = r.NodeType
	}

	plan := delayPlan{}
	for _, p := range paths {
		if p.unknownRole != "" || p.frames >= target {
			continue
		}
		deficit := target - p.frames

		assignedRole := ""
		for i := len(p.roles) - 1; i >= 0; i-- {
			role := p.roles[i]
			if delayCapable[nodeTypeByRole[role]] {
				assignedRole = role
				break
			}
		}
		label := strings.Join(p.roles, "→")
		if assignedRole == "" {
			return nil, fmt.Errorf("%w: Pfad %s braucht %d Frames Verzögerung, aber keine Rolle entlang des Pfads unterstützt setOutputDelay",
				ErrLatencyBudgetInsufficient, label, deficit)
		}
		if existing, ok := plan[assignedRole]; ok && existing != deficit {
			return nil, fmt.Errorf("%w: Rolle %q bräuchte widersprüchliche Verzögerungen (%d bzw. %d Frames) für verschiedene Pfade",
				ErrLatencyBudgetInsufficient, assignedRole, existing, deficit)
		}
		plan[assignedRole] = deficit
	}
	return plan, nil
}

// applyDelayPlan wendet den D8-Teil-3-Verzögerungsplan auf die gerade
// registrierten Rollen an — aufgerufen aus runStart, nachdem die
// Connections gewirkt haben, aber bevor der Workflow als "started" gilt.
// Best effort wie restoreRoleState: Start() hat die Zuweisbarkeit bereits
// als harten Preflight geprüft (computeDelayPlan-Aufruf dort), ein
// Fehlschlag hier ist ein Live-Betriebsproblem des betroffenen Nodes
// (z. B. Methodenaufruf schlägt fehl), kein Konfigurationsfehler mehr —
// bricht den bereits laufenden Start nicht ab, wird nur geloggt.
func (s *Service) applyDelayPlan(ctx context.Context, wf Workflow) {
	plan, err := computeDelayPlan(wf.Definition, s.launcher.Catalog())
	if err != nil {
		slog.Warn("workflows: applyDelayPlan: recompute failed despite passed preflight", "workflow", wf.ID, "error", err)
		return
	}
	for role, frames := range plan {
		node, ok := s.nodeForRole(wf, role)
		if !ok {
			slog.Warn("workflows: applyDelayPlan: role not registered", "workflow", wf.ID, "role", role)
			continue
		}
		if err := s.methods.Invoke(ctx, node.APIBaseURL, "setOutputDelay", map[string]any{"frames": frames}); err != nil {
			slog.Warn("workflows: applyDelayPlan: setOutputDelay failed", "workflow", wf.ID, "role", role, "frames", frames, "error", err)
		}
	}
}

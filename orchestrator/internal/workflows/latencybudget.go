package workflows

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// ErrLatencyBudgetInsufficient wird von Start() geliefert, wenn
// Definition.Settings.TargetLatencyFrames kleiner ist als die
// Mindestlatenz mindestens eines Pfads im Verbindungs-Template, oder
// wenn eine Rolle entlang eines Pfads keine Video-Latenz deklariert (D8
// Teil 2, ARCHITECTURE.md §15.1 Punkt 2) — ehrliche Ablehnung statt
// stillem Kürzer-Start, dieselbe Haltung wie beim I/O-Karten-Fall §6.1.
// §15.2s Fallback für unbekannte Latenz ("hoch annehmen") wird hier
// wörtlich als Ablehnung umgesetzt statt eines erfundenen Zahlenwerts.
var ErrLatencyBudgetInsufficient = errors.New("workflows: latency budget insufficient")

// latencyPathResult ist das Ergebnis der Pfad-Enumeration für genau
// einen Quelle→Senke-Pfad.
type latencyPathResult struct {
	roles       []string // Rollennamen entlang des Pfads, in Reihenfolge
	frames      uint32   // Summe der bekannten minLatencyFrames(video)
	unknownRole string   // != "", falls eine Rolle entlang des Pfads keine Video-Latenz deklariert
	unknownType string
}

// buildVideoLatencyLookup baut eine nodeType -> *launcher.LatencyRange
// (Video, D8 Teil 1) Nachschlagetabelle aus dem Katalog. Bewusst nur
// Video in dieser Scheibe (D8 Teil 2) — Audio/Daten s. D8 Teil 4.
func buildVideoLatencyLookup(catalog []launcher.CatalogEntry) map[string]*launcher.LatencyRange {
	lookup := make(map[string]*launcher.LatencyRange, len(catalog))
	for _, entry := range catalog {
		if entry.Latency != nil && entry.Latency.Video != nil {
			lookup[entry.Type] = entry.Latency.Video
		}
	}
	return lookup
}

// enumerateLatencyPaths findet alle einfachen Quelle→Senke-Pfade im
// Verbindungs-Template (Rolle→Rolle-Graph aus Definition.Connections,
// §15.1 Punkt 2: "für jeden Pfad im Verbindungs-Template ... ein Pfad
// pro Quelle→Senke-Route") und berechnet je Pfad die Summe der
// deklarierten minLatencyFrames(video) der beteiligten Rollen. Eine
// Quelle ist eine Rolle ohne eingehende Connection (auch eine Rolle ganz
// ohne jede Connection zählt als trivialer Ein-Rollen-Pfad, Quelle und
// Senke zugleich). Ein Zyklus im Verbindungs-Template ist ein
// Definitionsfehler (Medienfluss ist strukturell gerichtet, sollte in
// der Praxis nie auftreten) und wird als ErrValidation gemeldet statt
// in eine Endlosrekursion zu laufen.
func enumerateLatencyPaths(def Definition, lookup map[string]*launcher.LatencyRange) ([]latencyPathResult, error) {
	nodeTypeByRole := make(map[string]string, len(def.Roles))
	for _, r := range def.Roles {
		nodeTypeByRole[r.Name] = r.NodeType
	}

	outgoing := map[string][]string{} // fromRole -> []toRole
	hasIncoming := map[string]bool{}
	for _, c := range def.Connections {
		outgoing[c.FromRole] = append(outgoing[c.FromRole], c.ToRole)
		hasIncoming[c.ToRole] = true
	}

	var sources []string
	for _, r := range def.Roles {
		if !hasIncoming[r.Name] {
			sources = append(sources, r.Name)
		}
	}
	// Deterministische Reihenfolge (Tests/Fehlermeldungen sollen nicht
	// von Go-Map-Iterationsreihenfolge abhängen).
	sort.Strings(sources)

	var results []latencyPathResult
	visitedAny := map[string]bool{}
	for _, src := range sources {
		visiting := map[string]bool{}
		if err := walkLatencyPath(src, nil, 0, "", "", nodeTypeByRole, outgoing, lookup, visiting, visitedAny, &results); err != nil {
			return nil, err
		}
	}

	// Ein Zyklus OHNE jede Quelle (jede beteiligte Rolle hat eine
	// eingehende Connection, z. B. a→b→a) hat gar keinen Einstiegspunkt
	// für die Quelle-Traversal oben — sources bliebe fälschlich leer,
	// der Zyklus würde sonst still übergangen statt gemeldet. Jede Rolle
	// muss von mindestens einem Pfad erreicht werden, sonst ist sie Teil
	// eines solchen isolierten Zyklus.
	for _, r := range def.Roles {
		if !visitedAny[r.Name] {
			return nil, fmt.Errorf("%w: connection template contains a cycle at role %q", ErrValidation, r.Name)
		}
	}

	return results, nil
}

// walkLatencyPath ist eine DFS über den Verbindungsgraphen. pathRoles/
// frames/unknownRole/unknownType werden bewusst per Wert übergeben (statt
// eines gemeinsam mutierten Aufrufer-Zustands) — jeder rekursive Ast
// bekommt so automatisch seine eigene, unabhängige Kopie, kein manuelles
// Backtracking nötig. pathRoles wird bei jedem Schritt frisch kopiert
// (append auf einem neuen Backing-Array), damit parallele Geschwister-
// Äste im selben Aufrufbaum sich nicht denselben Backing-Array-Speicher
// teilen.
func walkLatencyPath(
	role string,
	pathRoles []string,
	frames uint32,
	unknownRole, unknownType string,
	nodeTypeByRole map[string]string,
	outgoing map[string][]string,
	lookup map[string]*launcher.LatencyRange,
	visiting map[string]bool,
	visitedAny map[string]bool,
	results *[]latencyPathResult,
) error {
	if visiting[role] {
		return fmt.Errorf("%w: connection template contains a cycle at role %q", ErrValidation, role)
	}
	visiting[role] = true
	visitedAny[role] = true
	defer delete(visiting, role)

	pathRoles = append(append([]string(nil), pathRoles...), role)
	if r, ok := lookup[nodeTypeByRole[role]]; ok {
		frames += r.MinLatencyFrames
	} else if unknownRole == "" {
		unknownRole = role
		unknownType = nodeTypeByRole[role]
	}

	next := outgoing[role]
	if len(next) == 0 {
		*results = append(*results, latencyPathResult{
			roles:       pathRoles,
			frames:      frames,
			unknownRole: unknownRole,
			unknownType: unknownType,
		})
		return nil
	}
	for _, n := range next {
		if err := walkLatencyPath(n, pathRoles, frames, unknownRole, unknownType, nodeTypeByRole, outgoing, lookup, visiting, visitedAny, results); err != nil {
			return err
		}
	}
	return nil
}

// checkLatencyBudget prüft Definition.Settings.TargetLatencyFrames gegen
// alle Pfade im Verbindungs-Template (D8 Teil 2). target==0 bedeutet
// "nicht gesetzt" — keine Prüfung, exakt das Verhalten vor diesem Feld
// (gleiche 0-Konvention wie ProgramWidth/-Height). Liefert nil, wenn
// kein Pfad das Budget verletzt und keine Rolle unbekannte Latenz hat.
func checkLatencyBudget(def Definition, catalog []launcher.CatalogEntry) error {
	target := def.Settings.TargetLatencyFrames
	if target == 0 {
		return nil
	}

	lookup := buildVideoLatencyLookup(catalog)
	paths, err := enumerateLatencyPaths(def, lookup)
	if err != nil {
		return err
	}

	for _, p := range paths {
		label := strings.Join(p.roles, "→")
		if p.unknownRole != "" {
			return fmt.Errorf("%w: Latenzbudget für Pfad %s kann nicht geprüft werden: Rolle %q (Typ %q) deklariert keine Video-Latenz",
				ErrLatencyBudgetInsufficient, label, p.unknownRole, p.unknownType)
		}
		if p.frames > target {
			return fmt.Errorf("%w: Zielband zu knapp für Pfad %s, Minimum %d Frames (targetLatencyFrames=%d)",
				ErrLatencyBudgetInsufficient, label, p.frames, target)
		}
	}
	return nil
}

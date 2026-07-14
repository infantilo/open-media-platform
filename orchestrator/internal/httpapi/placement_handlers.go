package httpapi

import (
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
)

// PlacementAdvisor liefert den aktuellen, advisory-only Alarm-Stand der
// Placement-Engine (implementiert von *placement.Engine, ARCHITECTURE.md
// §6.1, UMSETZUNG.md D6 Teil 3).
type PlacementAdvisor interface {
	List() []placement.Advice
}

// handleListPlacementAdvice ist GET /api/v1/placement/advice —
// authentifiziert, kein weiterer Verb-Scope (view-artig, gleiches
// Muster wie GET /api/v1/hosts). Liefert bewusst nie mehr als den
// zuletzt berechneten Stand — kein Trigger für einen sofortigen
// Neu-Lauf, die Engine bewertet unabhängig vom Polling-Client im
// eigenen Takt (placement.EvaluateInterval).
func handleListPlacementAdvice(advisor PlacementAdvisor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, advisor.List())
	}
}

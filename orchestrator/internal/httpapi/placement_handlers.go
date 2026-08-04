package httpapi

import (
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
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

// MigrationController ist die von *workflows.Service implementierte
// Teilmenge für die auto-confirm-window-Bedienung (D6 Teil 4,
// ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2).
type MigrationController interface {
	PendingMigrations() []workflows.PendingMigrationView
	ConfirmMigration(workflowID, role string) error
	CancelMigration(workflowID, role string) error
}

// handleListPendingMigrations ist GET /api/v1/placement/migrations —
// view-artig wie handleListPlacementAdvice, listet alle aktuell
// laufenden auto-confirm-window-Countdowns.
func handleListPendingMigrations(svc MigrationController) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.PendingMigrations())
	}
}

// handleConfirmMigration ist POST
// /api/v1/placement/migrations/{workflowId}/{role}/confirm — führt einen
// laufenden Countdown sofort aus, statt auf den Ablauf zu warten.
func handleConfirmMigration(svc MigrationController) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := svc.ConfirmMigration(r.PathValue("workflowId"), r.PathValue("role"))
		writeMigrationResult(w, err)
	}
}

// handleCancelMigration ist POST
// /api/v1/placement/migrations/{workflowId}/{role}/cancel — verwirft
// einen laufenden Countdown ersatzlos, die alte Instanz bleibt
// unangetastet.
func handleCancelMigration(svc MigrationController) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := svc.CancelMigration(r.PathValue("workflowId"), r.PathValue("role"))
		writeMigrationResult(w, err)
	}
}

func writeMigrationResult(w http.ResponseWriter, err error) {
	if err != nil {
		if errors.Is(err, workflows.ErrNoPendingMigration) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

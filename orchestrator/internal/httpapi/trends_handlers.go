package httpapi

import (
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/trends"
)

// Baseline und Trends (UMSETZUNG.md Kap. 72.11).

// WithTrends aktiviert GET /api/v1/admin/trends und die Trend-Befunde im Selbsttest.
func WithTrends(a *trends.Analyzer) HandlerOption { return func(o *handlerOptions) { o.trends = a } }

// handleTrends liefert GET /api/v1/admin/trends: die aktuellen Auffälligkeiten mit Verlauf zum Zeichnen und wie viel Verlauf die
// Auswertung überhaupt hat (die Baseline braucht mindestens drei Tage).
func handleTrends(a *trends.Analyzer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.Current())
	}
}

// trendInputs übersetzt die Auffälligkeiten für den Selbsttest.
func trendInputs(a *trends.Analyzer) []support.TrendFinding {
	if a == nil {
		return nil
	}
	var out []support.TrendFinding
	for _, f := range a.Current().Findings {
		out = append(out, support.TrendFinding{Subject: f.Subject, Label: f.Label, Metric: f.Metric, Kind: f.Kind, Unit: f.Unit,
			Value: f.Value, Baseline: f.Baseline, SlopePerHour: f.SlopePerHour, Hours: f.Hours, HoursToLimit: f.HoursToLimit})
	}
	return out
}

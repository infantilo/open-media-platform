package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/housekeeping"
)

// DBHealthFunc liefert den aktuellen Datenbankzustand (housekeeping.CheckHealth).
type DBHealthFunc func(ctx context.Context) (housekeeping.Health, error)

// WithDBHealth aktiviert GET /api/v1/admin/db-health, die Datenbank-Metriken und den Selbsttest-Befund.
func WithDBHealth(f DBHealthFunc) HandlerOption {
	return func(o *handlerOptions) { o.dbHealth = f }
}

func handleDBHealth(f DBHealthFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		h, err := f(ctx)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		if h.Findings == nil {
			h.Findings = []housekeeping.Finding{}
		}
		writeJSON(w, http.StatusOK, h)
	}
}

// dbHealthMetrics schreibt Größe und Müllanteil der Datenbank für Prometheus.
func dbHealthMetrics(f DBHealthFunc) func(io.Writer) {
	if f == nil {
		return nil
	}
	return func(w io.Writer) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h, err := f(ctx)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "# HELP omp_db_size_bytes Size of the OMP database.\n# TYPE omp_db_size_bytes gauge\nomp_db_size_bytes %d\n", h.DatabaseBytes)
		fmt.Fprintf(w, "# HELP omp_db_connections Open connections to the OMP database.\n# TYPE omp_db_connections gauge\nomp_db_connections %d\n", h.Connections)
		if h.Volume != nil {
			fmt.Fprintf(w, "# HELP omp_db_volume_free_bytes Free space on the database volume.\n# TYPE omp_db_volume_free_bytes gauge\nomp_db_volume_free_bytes %d\n", h.Volume.FreeBytes)
		}
		fmt.Fprintf(w, "# HELP omp_db_table_bytes Total size of a table including indexes (largest tables only).\n# TYPE omp_db_table_bytes gauge\n")
		for _, t := range h.Tables {
			fmt.Fprintf(w, "omp_db_table_bytes{table=%q} %d\n", t.Name, t.Bytes)
		}
		fmt.Fprintf(w, "# HELP omp_db_table_dead_tuples Dead rows waiting for vacuum.\n# TYPE omp_db_table_dead_tuples gauge\n")
		for _, t := range h.Tables {
			fmt.Fprintf(w, "omp_db_table_dead_tuples{table=%q} %d\n", t.Name, t.DeadTuples)
		}
	}
}

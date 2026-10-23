package jobs

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
)

const schema = `
CREATE TABLE IF NOT EXISTS jobrun_jobs (
    id         TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobrun_jobs_updated ON jobrun_jobs (updated_at DESC);
`

// store persistiert Job-Datensätze (Verlauf nach Neustart; die Ausführung selbst wird nicht übernommen).
type store struct{ db *sql.DB }

func (s store) Save(j jobrun.Job) {
	data, err := json.Marshal(j)
	if err != nil {
		return
	}
	if _, err := s.db.Exec(`INSERT INTO jobrun_jobs (id, state, data, updated_at) VALUES ($1,$2,$3,now())
		ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, data=EXCLUDED.data, updated_at=now()`, j.ID, string(j.State), data); err != nil {
		slog.Warn("jobs: Job nicht gespeichert", "job", j.ID, "error", err)
	}
}

// restore markiert nach einem Neustart unterbrochene Jobs als fehlgeschlagen und liefert den Verlauf.
func (s store) restore() []jobrun.Job {
	rows, err := s.db.Query(`SELECT data FROM jobrun_jobs ORDER BY updated_at DESC LIMIT 200`)
	if err != nil {
		slog.Warn("jobs: Verlauf nicht lesbar", "error", err)
		return nil
	}
	defer rows.Close()
	var out []jobrun.Job
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) != nil {
			continue
		}
		var j jobrun.Job
		if json.Unmarshal(raw, &j) != nil {
			continue
		}
		if j.State == jobrun.StateQueued || j.State == jobrun.StateRunning {
			now := time.Now()
			j.State, j.Finished, j.Error, j.Paused, j.Wait = jobrun.StateFailed, &now, "Orchestrator wurde neu gestartet", false, ""
			j.Events = append(j.Events, jobrun.JobEvent{At: now, Kind: "restart", Detail: "unterbrochen durch Neustart"})
			defer s.Save(j)
		}
		out = append(out, j)
	}
	return out
}

-- Echte Läufe von Workflows (Nutzerwunsch 2026-10-01: im Scheduler geplante
-- Zeit gegen reale Zeit zeigen, z. B. vorzeitig manuell beendet). Eine Zeile
-- je Lauf; ended_at NULL = läuft noch. workflow_name wird mitgeführt, damit
-- der Verlauf auch nach Umbenennen/Löschen des Workflows lesbar bleibt (kein
-- FOREIGN KEY). Aufbewahrung: OMP_WORKFLOW_RUN_RETENTION_DAYS (Standard 30).
CREATE TABLE IF NOT EXISTS workflow_runs (
    id            BIGSERIAL PRIMARY KEY,
    workflow_id   TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ,
    start_source  TEXT NOT NULL,
    end_reason    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS workflow_runs_started_idx ON workflow_runs (started_at);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_open ON workflow_runs (workflow_id) WHERE ended_at IS NULL;

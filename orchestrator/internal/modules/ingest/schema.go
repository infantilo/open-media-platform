package ingest

import "github.com/infantilo/openmediaplatform/orchestrator/internal/module"

// Migrations: Tabellen des Ingest-Moduls (Version 1 = Kapitel 42). Nie nachträglich ändern — neue Version anhängen.
func (*Module) Migrations() []module.Migration {
	return []module.Migration{{Version: 1, Name: "ingest-schedules-jobs-reservations", SQL: schemaV1}}
}

const schemaV1 = `
CREATE TABLE IF NOT EXISTS ingest_schedules (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT true,
    revision         INT NOT NULL DEFAULT 1,
    source           JSONB NOT NULL,
    spec             JSONB NOT NULL,
    profile_id       TEXT NOT NULL,
    storage          JSONB NOT NULL DEFAULT '{}',
    metadata         JSONB NOT NULL DEFAULT '{}',
    priority         INT NOT NULL DEFAULT 5,
    retry            JSONB NOT NULL DEFAULT '{}',
    late             JSONB NOT NULL DEFAULT '{}',
    host_pref        TEXT NOT NULL DEFAULT '',
    created_by       TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ingest_jobs (
    id                   TEXT PRIMARY KEY,
    schedule_id          TEXT NOT NULL DEFAULT '',
    idempotency_key      TEXT NOT NULL UNIQUE,
    occurrence_index     INT NOT NULL DEFAULT 0,
    name                 TEXT NOT NULL DEFAULT '',
    planned_start        TIMESTAMPTZ NOT NULL,
    planned_end          TIMESTAMPTZ NOT NULL,
    tz                   TEXT NOT NULL DEFAULT 'UTC',
    shifted              BOOLEAN NOT NULL DEFAULT false,
    ambiguous            BOOLEAN NOT NULL DEFAULT false,
    state                TEXT NOT NULL,
    state_since          TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempt              INT NOT NULL DEFAULT 0,
    max_attempts         INT NOT NULL DEFAULT 1,
    priority             INT NOT NULL DEFAULT 5,
    source               JSONB NOT NULL,
    source_key           TEXT NOT NULL DEFAULT '',
    profile_id           TEXT NOT NULL,
    host_pref            TEXT NOT NULL DEFAULT '',
    host_id              TEXT NOT NULL DEFAULT '',
    instance_id          TEXT NOT NULL DEFAULT '',
    file_rel             TEXT NOT NULL DEFAULT '',
    file_path            TEXT NOT NULL DEFAULT '',
    asset_id             TEXT NOT NULL DEFAULT '',
    actual_start         TIMESTAMPTZ,
    actual_end           TIMESTAMPTZ,
    start_deviation_ms   BIGINT,
    error                TEXT NOT NULL DEFAULT '',
    failed_stage         TEXT NOT NULL DEFAULT '',
    verdicts             JSONB,
    earliest_start       TIMESTAMPTZ,
    storage              JSONB NOT NULL DEFAULT '{}',
    metadata             JSONB NOT NULL DEFAULT '{}',
    late                 JSONB NOT NULL DEFAULT '{}',
    revision             INT NOT NULL DEFAULT 1,
    created_by           TEXT NOT NULL DEFAULT '',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_jobs_state_idx ON ingest_jobs (state, planned_start);
CREATE INDEX IF NOT EXISTS ingest_jobs_sched_idx ON ingest_jobs (schedule_id, planned_start);

CREATE TABLE IF NOT EXISTS ingest_job_events (
    id         BIGSERIAL PRIMARY KEY,
    job_id     TEXT NOT NULL,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    from_state TEXT NOT NULL DEFAULT '',
    to_state   TEXT NOT NULL DEFAULT '',
    message    TEXT NOT NULL DEFAULT '',
    detail     JSONB
);
CREATE INDEX IF NOT EXISTS ingest_job_events_idx ON ingest_job_events (job_id, id);

CREATE TABLE IF NOT EXISTS ingest_reservations (
    id        BIGSERIAL PRIMARY KEY,
    job_id    TEXT NOT NULL,
    host_id   TEXT NOT NULL,
    resource  TEXT NOT NULL,
    amount    DOUBLE PRECISION NOT NULL,
    origin    TEXT NOT NULL DEFAULT '',
    t_start   TIMESTAMPTZ NOT NULL,
    t_end     TIMESTAMPTZ NOT NULL,
    state     TEXT NOT NULL DEFAULT 'held'
);
CREATE INDEX IF NOT EXISTS ingest_reservations_job_idx ON ingest_reservations (job_id);
CREATE INDEX IF NOT EXISTS ingest_reservations_host_idx ON ingest_reservations (host_id, state, t_end);

CREATE TABLE IF NOT EXISTS ingest_profile_stats (
    profile_id    TEXT PRIMARY KEY,
    samples       INT NOT NULL DEFAULT 0,
    bytes_per_s   DOUBLE PRECISION NOT NULL DEFAULT 0,
    cpu_p95       DOUBLE PRECISION NOT NULL DEFAULT 0,
    mem_mb        DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

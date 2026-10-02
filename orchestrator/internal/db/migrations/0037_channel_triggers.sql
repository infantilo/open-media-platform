-- Kapitel 27 / P7: Channel-Trigger (Spec §77–90, §163–165). Ein Trigger wird vom Orchestrator
-- vermittelt (Rechteprüfung, Audit), per NATS an den Ziel-Channel zugestellt und vom Ziel
-- quittiert. Jede Zustellung ist eine eigene Zeile (ein Trigger an eine Gruppe = n Zeilen mit
-- derselben correlation_id) — daraus entsteht der Trigger-Graph (§162).
CREATE TABLE IF NOT EXISTS channel_trigger_rules (
    id         TEXT PRIMARY KEY,
    -- "channel:<id>" | "group:<name>" | "*"
    origin     TEXT NOT NULL,
    target     TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (origin, target)
);

CREATE TABLE IF NOT EXISTS channel_triggers (
    id                 TEXT PRIMARY KEY,
    correlation_id     TEXT NOT NULL,
    origin_channel     TEXT NOT NULL,
    target_channel     TEXT NOT NULL,
    event              TEXT NOT NULL,
    args               JSONB NOT NULL DEFAULT '{}',
    target_time        TIMESTAMPTZ,
    relative_offset_ms BIGINT NOT NULL DEFAULT 0,
    late_policy        TEXT NOT NULL DEFAULT 'EXECUTE_IMMEDIATELY',
    seq                BIGINT NOT NULL,
    created_by         TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- published | scheduled | applied | applied_late | skipped_late | failed | rejected | denied | expired
    status             TEXT NOT NULL,
    detail             TEXT NOT NULL DEFAULT '',
    status_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts           INT NOT NULL DEFAULT 0,
    last_attempt       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS channel_triggers_target_idx ON channel_triggers (target_channel, seq);
CREATE INDEX IF NOT EXISTS channel_triggers_created_idx ON channel_triggers (created_at DESC);
CREATE INDEX IF NOT EXISTS channel_triggers_open_idx ON channel_triggers (status) WHERE status = 'published';

-- Playout-Automation Kapitel 27 / P1a (UMSETZUNG.md §27, Entscheidung E1/E2
-- 2026-10-02): Channels als persistierte Domain-Objekte (eine Automator-
-- Instanz pro Channel), ihr Automationszustand als versionierter Snapshot
-- und ein Journal bereits ausgeführter Aktionen (Idempotenz nach Restart,
-- Spec §56/§116). Zeitstempel sind UTC (E5); `timezone` ist nur die
-- Planungs-/Anzeige-Zeitzone des Channels (IANA-Name).
CREATE TABLE IF NOT EXISTS playout_channels (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    -- Channel-Gruppe für Trigger-Adressierung (Spec §83/§163: national, regional, ...)
    channel_group TEXT NOT NULL DEFAULT '',
    -- aktuell gebundene Automator-Instanz ('' = keine). Eine Instanz gehört
    -- höchstens einem Channel (eindeutiger Teilindex).
    instance_id   TEXT NOT NULL DEFAULT '',
    -- Output-/Branding-/Audio-Kontext usw.: bewusst freies JSON, bis die
    -- jeweilige Phase (P4–P6) ihre Felder festlegt.
    config        JSONB NOT NULL DEFAULT '{}',
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS playout_channels_instance_uniq ON playout_channels (instance_id) WHERE instance_id <> '';

-- Genau ein Snapshot je Channel; `version` ist der Zähler für Optimistic
-- Concurrency (Spec §168): ein Schreiber muss die zuletzt gelesene Version
-- angeben, sonst Konflikt.
CREATE TABLE IF NOT EXISTS playout_state (
    channel_id TEXT PRIMARY KEY REFERENCES playout_channels(id) ON DELETE CASCADE,
    version    BIGINT NOT NULL,
    state      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playout_executions (
    channel_id   TEXT NOT NULL REFERENCES playout_channels(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT '',
    executed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, execution_id)
);
CREATE INDEX IF NOT EXISTS playout_executions_time_idx ON playout_executions (executed_at);

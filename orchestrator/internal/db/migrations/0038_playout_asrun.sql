-- Kapitel 27 / P10: As-Run-Protokoll der Playout-Automation (Spec §117–119). Pro Primary Event
-- eine Zeile (laufend aktualisiert: RUNNING → Endstatus), je Child Event eine Zeile, je manuellem
-- Eingriff eine Zeile (Wer/Was/Wann), dazu Warnungen (Quell-/Audio-Auflösung, Preflight). Die
-- Schlüssel sind idempotent: der Node liefert mindestens einmal, doppelte Lieferung überschreibt
-- dieselbe Zeile.
CREATE TABLE IF NOT EXISTS playout_asrun (
    id                  BIGSERIAL PRIMARY KEY,
    channel_id          TEXT NOT NULL,
    rec_key             TEXT NOT NULL,
    -- primary | child | operator | trigger | warning
    kind                TEXT NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_id            TEXT NOT NULL DEFAULT '',
    child_id            TEXT NOT NULL DEFAULT '',
    label               TEXT NOT NULL DEFAULT '',
    asset               TEXT NOT NULL DEFAULT '',
    source              TEXT NOT NULL DEFAULT '',
    planned_start       TIMESTAMPTZ,
    actual_start        TIMESTAMPTZ,
    planned_duration_ms BIGINT,
    actual_end          TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT '',
    reason              TEXT NOT NULL DEFAULT '',
    mode                TEXT NOT NULL DEFAULT '',
    operator            TEXT NOT NULL DEFAULT '',
    action              TEXT NOT NULL DEFAULT '',
    correlation_id      TEXT NOT NULL DEFAULT '',
    detail              JSONB NOT NULL DEFAULT '{}',
    UNIQUE (channel_id, rec_key)
);
CREATE INDEX IF NOT EXISTS playout_asrun_time_idx ON playout_asrun (channel_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS playout_asrun_kind_idx ON playout_asrun (channel_id, kind, recorded_at DESC);

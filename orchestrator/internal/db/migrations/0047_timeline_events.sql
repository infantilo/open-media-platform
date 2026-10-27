-- Ereignis-Zeitleiste (Kap. 72.6): Betriebsereignisse, die sonst nur flüchtig über den SSE-Hub laufen (Abstürze, Neustarts, Failover,
-- Medien-Ausfälle, Host-Ausfälle, Uhr-Sprünge, Marker). Bedienungen (audit_log), Domänen-Audit und Fehler-Logs werden beim Lesen
-- hinzugemischt und nicht doppelt gespeichert. dedup_key verhindert Doppelzeilen, wenn mehrere Orchestratoren dasselbe Ereignis sehen.
CREATE TABLE IF NOT EXISTS timeline_events (
    id         BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'info',
    subject    TEXT NOT NULL DEFAULT '',
    actor      TEXT NOT NULL DEFAULT '',
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedup_key  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS timeline_events_occurred_at_idx ON timeline_events (occurred_at DESC);

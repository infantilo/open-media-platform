-- Zentraler Log-Kanal (ARCHITECTURE.md §25.2) — Postgres-Projektion des
-- NATS-JetStream-Streams OMP_LOGS. Gleiches Muster wie audit_log
-- (0002_auth.sql): eine schreibende Tabelle, mit Index auf die für
-- Filterung/Cursor genutzten Spalten. trace_id/span_id/node_id/host_id
-- sind nullable, weil nicht jede Log-Zeile jedes Feld trägt (z. B. eine
-- rein orchestrator-interne Zeile ohne node_id).
CREATE TABLE IF NOT EXISTS logs (
    id          BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    level       TEXT NOT NULL,
    message     TEXT NOT NULL,
    trace_id    TEXT,
    span_id     TEXT,
    node_id     TEXT,
    host_id     TEXT,
    source      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS logs_occurred_at_idx ON logs (occurred_at);
CREATE INDEX IF NOT EXISTS logs_trace_id_idx ON logs (trace_id);
CREATE INDEX IF NOT EXISTS logs_node_id_idx ON logs (node_id);

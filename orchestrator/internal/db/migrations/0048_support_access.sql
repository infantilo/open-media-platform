-- Befristeter Support-Zugang (Kap. 72.9): ein Admin erzeugt einen Zugang mit Ablaufzeit; der Support meldet sich damit nur lesend an.
-- Das Token selbst wird nie gespeichert, nur sein SHA-256 (token_hash) — es wird dem Admin einmal angezeigt.
CREATE TABLE IF NOT EXISTS support_access (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    created_by    TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    first_used_at TIMESTAMPTZ,
    last_used_at  TIMESTAMPTZ,
    use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS support_access_expires_idx ON support_access (expires_at);

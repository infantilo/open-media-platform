-- Kapitel 29 Nachtrag B: benannte lokale Speicherorte (Verzeichnisse/Shares auf einem Host),
-- getrennt von den S3/MinIO-Backends (storage_backends): kein Objektspeicher, keine Zugangsdaten —
-- ein Pfad, den ein Host lokal eingehängt hat. host_id leer = der Orchestrator-Rechner.
CREATE TABLE IF NOT EXISTS storage_locations (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    host_id    TEXT NOT NULL DEFAULT '',
    path       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (host_id, path)
);

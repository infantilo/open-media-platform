package files

// schema: Kapitel 86 — Explorer-Wurzeln (Erweiterung der benannten Speicherorte), Dateizustand je Representation.
const schema = `
CREATE TABLE IF NOT EXISTS file_roots (
    location_id        TEXT PRIMARY KEY REFERENCES storage_locations(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'media',
    read_only          BOOLEAN NOT NULL DEFAULT false,
    trash_days         INT,
    emergency_free_gb  DOUBLE PRECISION,
    emergency_free_pct DOUBLE PRECISION,
    lock_before_h      DOUBLE PRECISION,
    lock_after_h       DOUBLE PRECISION,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Abgeleiteter Zustand je Representation (nicht Teil des Asset-Lebenszyklus): present | missing | unreachable | unknown.
-- miss_count: aufeinanderfolgende „fehlt“-Befunde (erst ab 2 gilt der Zustand missing, Flatterschutz).
CREATE TABLE IF NOT EXISTS representation_health (
    representation_id TEXT PRIMARY KEY REFERENCES representations(id) ON DELETE CASCADE,
    asset_id          TEXT NOT NULL,
    state             TEXT NOT NULL,
    miss_count        INT NOT NULL DEFAULT 0,
    size_bytes        BIGINT,
    mtime_ms          BIGINT,
    host_id           TEXT NOT NULL DEFAULT '',
    root_id           TEXT NOT NULL DEFAULT '',
    rel               TEXT NOT NULL DEFAULT '',
    detail            TEXT NOT NULL DEFAULT '',
    checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    since             TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_state    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS representation_health_asset_idx ON representation_health (asset_id);
CREATE INDEX IF NOT EXISTS representation_health_state_idx ON representation_health (state);
`

// Version 2: gemeinsamer Speicher (z. B. Isilon): ein Ort, den mehrere Hosts bedienen können (Reihenfolge = Vorzug, Ausweichen bei Ausfall).
const schemaV2 = `
ALTER TABLE file_roots ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE file_roots ADD COLUMN IF NOT EXISTS hosts_json TEXT NOT NULL DEFAULT '[]';
`

// Version 3: Übertragungen (Kopieren/Verschieben zwischen Orten und Hosts) mit Fortschritt.
const schemaV3 = `
CREATE TABLE IF NOT EXISTS file_transfers (
    id            TEXT PRIMARY KEY,
    mode          TEXT NOT NULL,
    src_root_id   TEXT NOT NULL,
    dst_root_id   TEXT NOT NULL,
    src_paths     TEXT NOT NULL DEFAULT '[]',
    dst_dir       TEXT NOT NULL DEFAULT '',
    conflict      TEXT NOT NULL DEFAULT 'rename',
    status        TEXT NOT NULL,
    total_bytes   BIGINT NOT NULL DEFAULT 0,
    done_bytes    BIGINT NOT NULL DEFAULT 0,
    files_total   INT NOT NULL DEFAULT 0,
    files_done    INT NOT NULL DEFAULT 0,
    files_skipped INT NOT NULL DEFAULT 0,
    error         TEXT NOT NULL DEFAULT '',
    items_json    TEXT NOT NULL DEFAULT '[]',
    tmp_root_id   TEXT NOT NULL DEFAULT '',
    tmp_rel       TEXT NOT NULL DEFAULT '',
    created_by    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS file_transfers_created_idx ON file_transfers (created_at DESC);
`

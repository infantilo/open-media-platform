package radio

const schema = `
CREATE TABLE IF NOT EXISTS radio_shows (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    template    BOOLEAN NOT NULL DEFAULT false,
    status      TEXT NOT NULL DEFAULT 'draft',
    slot_start  TIMESTAMPTZ,
    slot_end    TIMESTAMPTZ,
    presenters  JSONB NOT NULL DEFAULT '[]',
    owner       TEXT NOT NULL DEFAULT '',
    tags        JSONB NOT NULL DEFAULT '[]',
    content     JSONB NOT NULL DEFAULT '{}',
    row_version INT NOT NULL DEFAULT 1,
    created_by  TEXT NOT NULL DEFAULT '',
    updated_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS radio_shows_slot_idx ON radio_shows (slot_start);
CREATE INDEX IF NOT EXISTS radio_shows_status_idx ON radio_shows (status);

CREATE TABLE IF NOT EXISTS radio_show_versions (
    show_id    TEXT NOT NULL REFERENCES radio_shows(id) ON DELETE CASCADE,
    version    INT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content    JSONB NOT NULL,
    PRIMARY KEY (show_id, version)
);
`

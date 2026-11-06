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

// Version 2: Wiederkehr (Vorlage → Sendungen), Zeitsteuerung des Status, Herkunft.
const schemaV2 = `
ALTER TABLE radio_shows ADD COLUMN IF NOT EXISTS recurrence JSONB;
ALTER TABLE radio_shows ADD COLUMN IF NOT EXISTS source_template_id TEXT NOT NULL DEFAULT '';
ALTER TABLE radio_shows ADD COLUMN IF NOT EXISTS auto_live BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS radio_shows_occurrence_idx ON radio_shows (source_template_id, slot_start) WHERE source_template_id <> '';

-- Gelöschte erzeugte Sendungen: die Wiederkehr legt sie nicht erneut an.
CREATE TABLE IF NOT EXISTS radio_show_skips (
    source_template_id TEXT NOT NULL,
    slot_start         TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_template_id, slot_start)
);
`

// Version 3: weiche Bearbeitungssperre (wer bearbeitet gerade) — ein Halter je Sendung, verfällt ohne Herzschlag.
const schemaV3 = `
CREATE TABLE IF NOT EXISTS radio_show_locks (
    show_id  TEXT PRIMARY KEY REFERENCES radio_shows(id) ON DELETE CASCADE,
    holder   TEXT NOT NULL,
    session  TEXT NOT NULL,
    since    TIMESTAMPTZ NOT NULL DEFAULT now(),
    beat     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

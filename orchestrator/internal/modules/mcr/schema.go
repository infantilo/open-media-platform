package mcr

import "github.com/infantilo/openmediaplatform/orchestrator/internal/module"

// Migrations: Tabellen des MCR-Moduls (Version 1 = Kapitel 106.9). Nie nachträglich ändern — neue Version anhängen.
func (*Module) Migrations() []module.Migration {
	return []module.Migration{
		{Version: 1, Name: "mcr-templates-events-lines-members", SQL: schemaV1},
		{Version: 2, Name: "mcr-event-warnings", SQL: schemaV2},
	}
}

const schemaV1 = `
CREATE TABLE IF NOT EXISTS mcr_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    lines       JSONB NOT NULL DEFAULT '[]',
    house_format JSONB,
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcr_events (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    template_id   TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT 'planned',
    planned_start TIMESTAMPTZ,
    planned_end   TIMESTAMPTZ,
    workflow_id   TEXT NOT NULL DEFAULT '',
    owner         TEXT NOT NULL DEFAULT '',
    owner_group   TEXT NOT NULL DEFAULT '',
    house_format  JSONB,
    created_by    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcr_events_state_idx ON mcr_events (state, planned_start);

CREATE TABLE IF NOT EXISTS mcr_lines (
    event_id     TEXT NOT NULL REFERENCES mcr_events(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    transport    JSONB NOT NULL DEFAULT '{}',
    normalize    JSONB NOT NULL DEFAULT '{}',
    avsync       JSONB NOT NULL DEFAULT '{}',
    record       JSONB NOT NULL DEFAULT '{}',
    intercom     JSONB NOT NULL DEFAULT '{}',
    house_format JSONB,
    position     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, id)
);

CREATE TABLE IF NOT EXISTS mcr_members (
    event_id     TEXT NOT NULL REFERENCES mcr_events(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL,
    subject      TEXT NOT NULL,
    event_role   TEXT NOT NULL,
    PRIMARY KEY (event_id, subject_type, subject)
);
`

// schemaV2 (106.12): Warnungen am Event (z. B. Rückweg ohne Quelle); der Abgleich überschreibt sie bei jedem Lauf.
const schemaV2 = `ALTER TABLE mcr_events ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]';`

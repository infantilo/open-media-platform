package mcr

import "github.com/infantilo/openmediaplatform/orchestrator/internal/module"

// Migrations: Tabellen des MCR-Moduls (Version 1 = Kapitel 106.9). Nie nachträglich ändern — neue Version anhängen.
func (*Module) Migrations() []module.Migration {
	return []module.Migration{
		{Version: 1, Name: "mcr-templates-events-lines-members", SQL: schemaV1},
		{Version: 2, Name: "mcr-event-warnings", SQL: schemaV2},
		{Version: 3, Name: "mcr-chain", SQL: schemaV3},
		{Version: 4, Name: "mcr-alarms-monitoring", SQL: schemaV4},
		{Version: 5, Name: "mcr-recordings", SQL: schemaV5},
		{Version: 6, Name: "mcr-bindings", SQL: schemaV6},
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

// schemaV3 (106.13g): Verarbeitungskette je Event und je Leitung (NULL = erbt).
const schemaV3 = `ALTER TABLE mcr_events ADD COLUMN IF NOT EXISTS chain JSONB;
ALTER TABLE mcr_lines ADD COLUMN IF NOT EXISTS chain JSONB;`

// schemaV4 (106.13d/e): Alarmhistorie und Überwachungseinstellungen (Profil, Abweichungen, Reaktionsregeln) je Event und Leitung.
const schemaV4 = `
ALTER TABLE mcr_events ADD COLUMN IF NOT EXISTS monitoring JSONB;
ALTER TABLE mcr_lines ADD COLUMN IF NOT EXISTS monitoring JSONB;
CREATE TABLE IF NOT EXISTS mcr_alarms (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL,
    line_id    TEXT NOT NULL,
    line_name  TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'warning',
    text       TEXT NOT NULL DEFAULT '',
    node_id    TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ,
    acked_by   TEXT NOT NULL DEFAULT '',
    acked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mcr_alarms_event_idx ON mcr_alarms (event_id, started_at DESC);
CREATE INDEX IF NOT EXISTS mcr_alarms_open_idx ON mcr_alarms (event_id, line_id, kind) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS mcr_alarms_started_idx ON mcr_alarms (started_at DESC);
`

// schemaV5 (106.13b): laufende und beendete Aufzeichnungsaufträge je Leitung (Ingest-Auftrag), damit nach einem Neustart nichts doppelt startet.
const schemaV5 = `
CREATE TABLE IF NOT EXISTS mcr_recordings (
    event_id   TEXT NOT NULL,
    line_id    TEXT NOT NULL,
    job_id     TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at TIMESTAMPTZ,
    PRIMARY KEY (event_id, line_id, job_id)
);
CREATE INDEX IF NOT EXISTS mcr_recordings_open_idx ON mcr_recordings (event_id) WHERE stopped_at IS NULL;
`

// schemaV6 (106.14): vom MCR angelegte Workflow-Bindungen je Event — nur diese werden beim Abbau wieder entfernt.
const schemaV6 = `
CREATE TABLE IF NOT EXISTS mcr_bindings (
    event_id     TEXT NOT NULL,
    binding_id   TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject      TEXT NOT NULL,
    verb         TEXT NOT NULL,
    PRIMARY KEY (event_id, binding_id)
);
`

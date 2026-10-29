package review

import "github.com/infantilo/openmediaplatform/orchestrator/internal/module"

// Migrations: Tabellen des Review-Moduls (Version 1 = Kapitel 43). Nie nachträglich ändern — neue Version anhängen.
func (*Module) Migrations() []module.Migration {
	return []module.Migration{
		{Version: 1, Name: "review-qc-conform", SQL: schemaV1},
		{Version: 2, Name: "review-assignment", SQL: schemaV2},
	}
}

// schemaV2 (Kapitel 44): Zuweisung einer Prüfaufgabe an eine Person oder Gruppe, mit Frist. Unabhängig vom Bearbeiter (`assignee`):
// der ist, wer die Datei gerade übernommen hat; die Zuweisung sagt, wer sie bearbeiten soll.
const schemaV2 = `
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS assigned_to TEXT NOT NULL DEFAULT '';
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS assigned_group TEXT NOT NULL DEFAULT '';
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS assigned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS review_items_assigned_idx ON review_items (assigned_to, state);
`

const schemaV1 = `
CREATE TABLE IF NOT EXISTS review_items (
    asset_id           TEXT PRIMARY KEY,
    source_version_id  TEXT NOT NULL,
    source_rep_id      TEXT NOT NULL,
    file_name          TEXT NOT NULL DEFAULT '',
    source_rev         TEXT NOT NULL DEFAULT '',
    size_bytes         BIGINT NOT NULL DEFAULT 0,
    format             TEXT NOT NULL DEFAULT '',
    ingest_job         TEXT NOT NULL DEFAULT '',
    state              TEXT NOT NULL,
    assignee           TEXT NOT NULL DEFAULT '',
    claimed_at         TIMESTAMPTZ,
    revision           BIGINT NOT NULL DEFAULT 1,
    qc_status          TEXT NOT NULL DEFAULT '',
    qc_fail_count      INT NOT NULL DEFAULT 0,
    qc_warn_count      INT NOT NULL DEFAULT 0,
    qc_report_id       TEXT NOT NULL DEFAULT '',
    timeline           JSONB,
    approval_mode      TEXT NOT NULL DEFAULT 'single',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_items_state_idx ON review_items (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS qc_jobs (
    id            TEXT PRIMARY KEY,
    asset_id      TEXT NOT NULL,
    source_rev    TEXT NOT NULL,
    profile_id    TEXT NOT NULL,
    state         TEXT NOT NULL,
    phase         TEXT NOT NULL DEFAULT '',
    progress      INT NOT NULL DEFAULT 0,
    attempts      INT NOT NULL DEFAULT 0,
    error         TEXT NOT NULL DEFAULT '',
    report_id     TEXT NOT NULL DEFAULT '',
    requested_by  TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    heartbeat_at  TIMESTAMPTZ
);
-- höchstens ein aktiver Auftrag je Asset (Idempotenz: doppeltes Auslösen erzeugt keine zweite Analyse)
CREATE UNIQUE INDEX IF NOT EXISTS qc_jobs_active_uq ON qc_jobs (asset_id) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS qc_jobs_queue_idx ON qc_jobs (state, created_at);

CREATE TABLE IF NOT EXISTS qc_reports (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL,
    asset_id    TEXT NOT NULL,
    source_rev  TEXT NOT NULL,
    overall     TEXT NOT NULL,
    counts      JSONB NOT NULL DEFAULT '{}',
    streams     JSONB,
    tools       JSONB NOT NULL DEFAULT '{}',
    profile     JSONB NOT NULL DEFAULT '{}',
    ruleset     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qc_reports_asset_idx ON qc_reports (asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS qc_findings (
    id           BIGSERIAL PRIMARY KEY,
    report_id    TEXT NOT NULL REFERENCES qc_reports(id) ON DELETE CASCADE,
    check_id     TEXT NOT NULL,
    category     TEXT NOT NULL,
    status       TEXT NOT NULL,
    severity     TEXT NOT NULL,
    message      TEXT NOT NULL DEFAULT '',
    measured     JSONB,
    threshold    JSONB,
    start_frame  BIGINT,
    end_frame    BIGINT,
    stream       INT,
    tool         TEXT NOT NULL DEFAULT '',
    tool_version TEXT NOT NULL DEFAULT '',
    analyzed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ruleset      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS qc_findings_report_idx ON qc_findings (report_id, id);

CREATE TABLE IF NOT EXISTS review_proxies (
    id          TEXT PRIMARY KEY,
    asset_id    TEXT NOT NULL,
    source_rev  TEXT NOT NULL,
    profile     TEXT NOT NULL,
    state       TEXT NOT NULL,
    path        TEXT NOT NULL DEFAULT '',
    frames      BIGINT NOT NULL DEFAULT 0,
    rate_num    BIGINT NOT NULL DEFAULT 0,
    rate_den    BIGINT NOT NULL DEFAULT 1,
    width       INT NOT NULL DEFAULT 0,
    height      INT NOT NULL DEFAULT 0,
    verified    BOOLEAN NOT NULL DEFAULT false,
    error       TEXT NOT NULL DEFAULT '',
    attempts    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ,
    UNIQUE (asset_id, source_rev, profile)
);

ALTER TABLE review_proxies ADD COLUMN IF NOT EXISTS audio_tracks INT NOT NULL DEFAULT 0;
ALTER TABLE review_proxies ADD COLUMN IF NOT EXISTS audio_path TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS conform_revisions (
    id             TEXT PRIMARY KEY,
    asset_id       TEXT NOT NULL,
    revision       INT NOT NULL,
    state          TEXT NOT NULL,
    source_rev     TEXT NOT NULL,
    usable_in      BIGINT,
    usable_out     BIGINT,
    asset_metadata JSONB NOT NULL DEFAULT '{}',
    note           TEXT NOT NULL DEFAULT '',
    created_by     TEXT NOT NULL,
    updated_by     TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by     TEXT NOT NULL DEFAULT '',
    decision_note  TEXT NOT NULL DEFAULT '',
    UNIQUE (asset_id, revision)
);
-- genau ein veränderlicher Entwurf je Asset
CREATE UNIQUE INDEX IF NOT EXISTS conform_draft_uq ON conform_revisions (asset_id) WHERE state = 'draft';

CREATE TABLE IF NOT EXISTS conform_segments (
    id          TEXT PRIMARY KEY,
    conform_id  TEXT NOT NULL REFERENCES conform_revisions(id) ON DELETE CASCADE,
    ord         INT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    in_frame    BIGINT NOT NULL,
    out_frame   BIGINT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (out_frame > in_frame AND in_frame >= 0)
);
CREATE INDEX IF NOT EXISTS conform_segments_idx ON conform_segments (conform_id, ord);

-- Assets ohne prüfbare Mediendatei (je Version einmal geprüft, nicht jede Runde neu)
CREATE TABLE IF NOT EXISTS review_skipped (
    asset_id   TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_history (
    id         BIGSERIAL PRIMARY KEY,
    asset_id   TEXT NOT NULL,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor      TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    from_state TEXT NOT NULL DEFAULT '',
    to_state   TEXT NOT NULL DEFAULT '',
    detail     JSONB
);
CREATE INDEX IF NOT EXISTS review_history_asset_idx ON review_history (asset_id, id);
`

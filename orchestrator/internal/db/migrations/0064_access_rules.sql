-- Zugriffsregeln für Quellen und Senken: wer sie sehen und schalten darf (Whitelist/Blacklist je Nutzer, Gruppe oder global).
-- Ohne Regeln bleibt alles wie bisher offen. Details: internal/accessrules.
CREATE TABLE IF NOT EXISTS access_rules (
    id             TEXT PRIMARY KEY,
    subject_type   TEXT NOT NULL CHECK (subject_type IN ('global', 'user', 'group')),
    subject        TEXT NOT NULL DEFAULT '',
    kind           TEXT NOT NULL CHECK (kind IN ('source', 'sink')),
    action         TEXT NOT NULL CHECK (action IN ('see', 'route')),
    effect         TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    selector_type  TEXT NOT NULL,
    selector_value TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    created_by     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_rules_subject ON access_rules (subject_type, subject);

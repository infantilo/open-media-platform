-- Funktionsrechte (Kapitel 44): benannte Rechte der Module (z. B. ingest.schedule.create, review.qc.run),
-- vergeben an Nutzer oder Gruppen. Ergänzt die Rollenbindungen (Verben auf Nodes/Workflows); `configure` global deckt alle ab.
CREATE TABLE IF NOT EXISTS feature_grants (
    id           TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL DEFAULT 'user',
    subject      TEXT NOT NULL,
    feature      TEXT NOT NULL,
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_type, subject, feature)
);
CREATE INDEX IF NOT EXISTS feature_grants_subject_idx ON feature_grants (subject_type, subject);

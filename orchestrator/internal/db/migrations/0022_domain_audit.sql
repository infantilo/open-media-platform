-- Domain-Audit (Kapitel 21, B13): additive Ergänzung zu audit_log
-- (0002_auth.sql), das nur HTTP-Request-Metadaten (Methode/Pfad/Status)
-- protokolliert. Hier: fachliche Aktionen mit Objektbezug ("Asset X auf
-- Status Y gesetzt", "Human-Task Z genehmigt") — bewusst ein eigenes,
-- additives Schema statt audit_log zu erweitern (21.1: "'Asset
-- created'/'Approval granted' passt nicht sauber in (Method,Path)").
CREATE TABLE IF NOT EXISTS domain_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    -- Strukturierte Zusatzangaben (z. B. {"from":"draft","to":"published"},
    -- {"decision":"approved","comment":"..."}) — Schema je action, daher
    -- JSONB statt eigener Spalten je möglichem Feld.
    details     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS domain_audit_log_occurred_at_idx ON domain_audit_log (occurred_at);
-- Häufigste Abfrage: "alle Ereignisse zu diesem Objekt", s. Store.ListByObject.
CREATE INDEX IF NOT EXISTS domain_audit_log_object_idx ON domain_audit_log (object_type, object_id, id DESC);

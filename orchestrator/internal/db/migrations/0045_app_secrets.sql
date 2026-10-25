-- Gemeinsame Geheimnisse aller Orchestrator-Instanzen eines Clusters (Audit 2026-10-23 H10): das JWT-Secret lag nur in einer
-- lokalen Datei — ein zweiter Orchestrator hätte fremde Tokens abgelehnt, nach Ausfall des ersten wären alle Sitzungen weg.
CREATE TABLE IF NOT EXISTS app_secrets (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

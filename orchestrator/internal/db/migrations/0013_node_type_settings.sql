-- Generischer Ablagemechanismus für Node-Typ-weite (nicht Instanz-
-- weite) Einstellungen, z. B. omp-mxf-players Programmgruppen/Shuffle-
-- Presets (bisher hart in nodes/omp-mxf-player/src/presets.rs codiert)
-- — Nutzerwunsch "sollten wir Shuffle Presets und Output Groups
-- dynamisch... definieren können, für einfachere künftige Anpassungen".
-- Gleiches Ein-Blob-pro-Schlüssel-Muster wie `catalog_entries`
-- (0009_catalog_entries.sql) und `layouts` (0001_init.sql): der
-- Orchestrator versteht das JSON pro Node-Typ nicht generisch, nur die
-- jeweilige Handler-Validierung tut das (s. httpapi node_settings_
-- handlers.go) — die Tabelle selbst bleibt bewusst schemalos, damit
-- künftige Node-Typen denselben Mechanismus ohne neue Migration
-- mitnutzen können.
CREATE TABLE IF NOT EXISTS node_type_settings (
    node_type  TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

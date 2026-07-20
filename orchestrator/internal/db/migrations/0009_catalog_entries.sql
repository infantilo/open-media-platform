-- §17 Teil 4 (docs/END-GOAL-FEATURES.md §17.3d/§17.4): importierte
-- Katalog-Einträge (Podman-Container-Images), zusätzlich zu den
-- statischen Einträgen aus deploy/catalog.json (die bleiben eine
-- versionierte Datei, keine Migration nach Postgres — nur importierte
-- Fremd-Einträge landen hier). Ein Blob pro Eintrag, gleiches Muster
-- wie instances/workflows (0004/0005): der Orchestrator interpretiert
-- das JSON in Go (internal/launcher.CatalogEntry), die DB kennt nur
-- "irgendein Katalog-Eintrag mit diesem Typnamen".
CREATE TABLE IF NOT EXISTS catalog_entries (
    type TEXT PRIMARY KEY,
    data JSONB NOT NULL
);

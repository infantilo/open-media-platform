-- Instanz-Launcher-Zustand (S4, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md)
-- ersetzt data/instances.json (UMSETZUNG.md C8) — ein Blob pro Instanz,
-- gleiches Muster wie workflows.data (0004_workflows.sql): der
-- Orchestrator interpretiert das JSON in Go (internal/launcher), die DB
-- kennt nur "irgendeine Instanz mit dieser ID". Kein Sortier-/Filter-
-- Bedarf in SQL (List() liefert immer den kompletten Bestand, der
-- Launcher selbst filtert per PID-Check beim Laden), deshalb keine
-- weiteren Spalten nötig.
CREATE TABLE IF NOT EXISTS instances (
    id   TEXT PRIMARY KEY,
    data JSONB NOT NULL
);

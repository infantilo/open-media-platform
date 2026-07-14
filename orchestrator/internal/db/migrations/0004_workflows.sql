-- Workflow-Bereitstellung & -Verteilung (ARCHITECTURE.md §6.2,
-- UMSETZUNG.md D7 Teil 1: das Workflow-Objekt selbst + manuelles
-- Bundle-Start/Stop, kein Scheduler/keine Ressourcen-Vorprüfung).
--
-- Ein Workflow ist als ein Blob gespeichert (wie snapshots.data, D1) —
-- der Orchestrator interpretiert das JSON in Go (internal/workflows),
-- die DB kennt nur "irgendein Workflow mit dieser ID". status/updated_at
-- sind zusätzlich echte Spalten (nicht nur Teil des Blobs), weil List()
-- danach sortiert bzw. filtert, gleiches Muster wie snapshots.created_at.
CREATE TABLE IF NOT EXISTS workflows (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'stopped',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    data       JSONB NOT NULL
);

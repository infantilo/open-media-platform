-- Layouts (UMSETZUNG.md B5) und Snapshots (B7) — beide bisher als eine
-- JSON-Datei pro Datensatz unter DataDir (layouts/<name>.json bzw.
-- snapshots/<id>.json). Schema hier bewusst schlank: der Orchestrator
-- bleibt "opak" gegenüber dem Layout-Blob-Inhalt (ARCHITECTURE.md §4.5a:
-- kein eigenes Datenmodell im Orchestrator). Snapshots bekommen
-- zusätzlich `created_at` als echte Spalte, weil der Store danach
-- sortiert (List(), vorher Dateisystem-Iteration + In-Memory-Sort).
--
-- layouts.data ist bewusst JSON, nicht JSONB: JSONB kanonisiert beim
-- Speichern (u. a. Leerzeichen nach ':', Schlüsselreihenfolge) und gibt
-- dadurch nicht mehr exakt die vom Client gesendeten Bytes zurück — für
-- reines Opak-Speichern (der Store interpretiert den Blob nie, fragt ihn
-- nie ab) ist das ein unnötiger Verlust der Byte-Treue, die das
-- ursprüngliche Datei-Backend hatte, ohne einen Gegenwert (keine Query/
-- Index-Nutzung auf dem Inhalt geplant). snapshots.data bleibt JSONB:
-- dort liest der Store den Inhalt ohnehin immer über Go-Structs
-- (json.Unmarshal), Byte-Treue spielt keine Rolle, JSONBs kompaktere
-- Binärspeicherung ist der bessere Default.

CREATE TABLE IF NOT EXISTS layouts (
    name       TEXT PRIMARY KEY,
    data       JSON NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshots (
    id         TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    data       JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_created_at_idx ON snapshots (created_at);

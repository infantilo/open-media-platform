-- Eingefrorene Momentaufnahmen (Kap. 72.10, „Flugschreiber“): die letzten Minuten des Systems als ZIP, manuell oder automatisch bei einer Störung
-- angelegt. Sie überleben die Ringpuffer (Minuten) und die Aufbewahrung von Logs und Zeitleiste und werden erst nach 30 Tagen oder bei
-- Überschreiten der Höchstzahl gelöscht.
CREATE TABLE IF NOT EXISTS freezes (
    id             TEXT PRIMARY KEY,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT NOT NULL DEFAULT '',
    trigger        TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    window_minutes INTEGER NOT NULL,
    scope          TEXT NOT NULL DEFAULT '[]',
    size_bytes     INTEGER NOT NULL,
    data           BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS freezes_created_at_idx ON freezes (created_at DESC);

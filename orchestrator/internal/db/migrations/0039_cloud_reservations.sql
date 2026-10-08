-- Kapitel 35 / 35.4b: geplante Cloud-Kapazität (ARCHITECTURE.md §27.4). Eine Reservierung verlangt, dass im
-- Pool `pool` von `from_at` bis `to_at` mindestens `host_count` Hosts BEREIT sind; der Pool-Controller fährt
-- dafür (um den Boot-Vorlauf früher) hoch und danach geordnet wieder ab. Keine Reservierungssperre (§16 Punkt 4).
CREATE TABLE IF NOT EXISTS cloud_reservations (
    id          TEXT PRIMARY KEY,
    pool        TEXT NOT NULL,
    host_count  INTEGER NOT NULL CHECK (host_count > 0),
    from_at     TIMESTAMPTZ NOT NULL,
    to_at       TIMESTAMPTZ NOT NULL CHECK (to_at > from_at),
    note        TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_reservations_time_idx ON cloud_reservations (to_at, from_at);

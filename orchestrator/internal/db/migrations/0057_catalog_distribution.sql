-- Verteilung importierter Microservices auf Hosts (Kap. 85): Soll-Zustand je (Typ, Version, Host) in Postgres, damit ein
-- Leader-Wechsel nichts verliert und später hinzugekommene oder zurückgekehrte Hosts nachziehen.
CREATE TABLE IF NOT EXISTS catalog_distribution (
    type       TEXT NOT NULL,
    version    TEXT NOT NULL,
    host_id    TEXT NOT NULL,
    desired    TEXT NOT NULL DEFAULT 'present',   -- present | absent
    state      TEXT NOT NULL DEFAULT 'pending',   -- pending | installing | ok | failed | offline | removing
    detail     TEXT NOT NULL DEFAULT '',
    image_id   TEXT NOT NULL DEFAULT '',
    attempts   INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (type, version, host_id)
);

-- Verteilschlüssel des Clusters (Ed25519). Liegt in der gemeinsamen Datenbank, damit jedes Mitglied nach einem
-- Leader-Wechsel mit demselben Schlüssel signiert. Der private Teil verlässt die Datenbank nie.
CREATE TABLE IF NOT EXISTS catalog_dist_key (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    private_key TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

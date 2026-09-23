-- Kapitel 21 B12 (Collections/Beziehungen) — additiv zur Asset-Domäne
-- aus 0019_assets.sql, bewusst erst jetzt angelegt (s. dortiger
-- Moduldoku-Kommentar: "B12 referenziert sie erst bei der
-- Collections-Arbeit").
--
-- Collections gruppieren Assets (m:n, ein Asset kann in mehreren
-- Collections liegen). Relationships sind gerichtete, typisierte Kanten
-- zwischen zwei Assets (derived_from/version_of/part_of/…, bewusst
-- TEXT ohne CHECK-Enum — gleiche "extensible types statt harter
-- Enumeration"-Linie wie assets.type, s. 0019_assets.sql).

CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_members (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    asset_id      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, asset_id)
);
-- Rückrichtung "in welchen Collections liegt Asset X" (Löschung eines
-- Assets muss seine Mitgliedschaften über den FK oben ohnehin mitnehmen
-- — dieser Index ist für die künftige "Collections dieses Assets"-
-- Abfrage, falls das Asset-Detailpanel sie einmal zeigen will).
CREATE INDEX IF NOT EXISTS collection_members_asset_idx ON collection_members (asset_id);

CREATE TABLE IF NOT EXISTS asset_relationships (
    id            TEXT PRIMARY KEY,
    from_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    to_asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- dieselbe gerichtete Beziehung desselben Typs zweimal anzulegen ist
    -- kein neuer Fakt.
    UNIQUE (from_asset_id, to_asset_id, type)
);
CREATE INDEX IF NOT EXISTS asset_relationships_to_idx ON asset_relationships (to_asset_id);

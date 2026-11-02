-- Feld-Registry für Asset-Metadaten (Kapitel 78.1, docs/ENTWURF-NORMEN-EBUCORE-R103-R143.md).
--
-- Das Speichermodell bleibt: assets.metadata ist weiterhin ein JSONB-Blob mit den
-- sechs Blöcken. Diese Tabelle beschreibt nur, WELCHE Felder es gibt (Typ,
-- Beschriftung, Pflicht, Auswahlliste) und worauf sie im Austauschformat EBUCore
-- (EBU Tech 3293) abgebildet werden. Schlüssel, die hier nicht stehen, bleiben als
-- freie Felder erlaubt.
CREATE TABLE IF NOT EXISTS asset_metadata_fields (
    id             TEXT PRIMARY KEY,
    -- '' = gilt für alle Asset-Typen (assets.type ist bewusst freier Text).
    asset_type     TEXT NOT NULL DEFAULT '',
    category       TEXT NOT NULL,
    key            TEXT NOT NULL,
    label          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    datatype       TEXT NOT NULL,
    required       BOOLEAN NOT NULL DEFAULT FALSE,
    multiple       BOOLEAN NOT NULL DEFAULT FALSE,
    enum_values    JSONB NOT NULL DEFAULT '[]',
    ebucore_target TEXT NOT NULL DEFAULT '',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_by     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (asset_type, category, key)
);

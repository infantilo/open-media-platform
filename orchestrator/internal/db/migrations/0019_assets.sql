-- Asset/Content-Domänenmodell (Kapitel 21 Phase 2, UMSETZUNG.md §6b/21.3+
-- 21.4) — angesiedelt im Orchestrator, NICHT in nodes/omp-media-library
-- (vom Nutzer am 2026-09-22 bestätigte Entscheidung: die Domäne braucht
-- Postgres/Authz/Audit/Tracing, die bereits hier leben, und muss von
-- Process-Executions referenzierbar sein).
--
-- Bewusst NUR Asset/AssetVersion/Representation (+ Metadata als JSONB-
-- Spalte auf assets) diese Runde — B1s volle Entitätsliste
-- (ContentObject/Collection/Sequence/Segment/Marker/Publication/Package)
-- ist laut der Aufgabenstellung selbst NICHT Teil von "Implementiere
-- zuerst" (Phase 2), sondern späterer Ausbau (B10/B12 referenzieren sie
-- erst bei der Asset↔Workflow-Integration bzw. Collections-Arbeit) —
-- kein ungenutztes Schema vorab anlegen.
--
-- assets.current_version_id verweist auf asset_versions.id,
-- asset_versions.asset_id verweist zurück auf assets.id — echter
-- Zirkelbezug zwischen den beiden Tabellen. Auflösung: assets zuerst
-- OHNE die current_version_id-FK anlegen, danach asset_versions, dann
-- den Fremdschlüssel per ALTER TABLE nachtragen.

CREATE TABLE IF NOT EXISTS assets (
    id                 TEXT PRIMARY KEY,
    -- type ist bewusst TEXT ohne CHECK-Enum (B2: "Keine harte Enumeration
    -- verwenden, wenn das bestehende OMP-Domainmodell extensible types
    -- unterstützt") — VIDEO/AUDIO/IMAGE/… sind Beispielwerte, kein
    -- geschlossener Satz.
    type               TEXT NOT NULL,
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'ingesting',
    current_version_id TEXT,
    -- metadata sitzt auf Asset-Ebene (nicht AssetVersion), exakt wie im
    -- Beziehungsdiagramm der Aufgabenstellung ("Asset -> Metadata" als
    -- Geschwister von "Asset -> Version") — kategorisiert in Go
    -- (asset.Metadata: system/technical/descriptive/editorial/custom/ai,
    -- B6), hier nur als ein JSONB-Blob (B7/MetadataSchema-Validierung
    -- bewusst nicht Teil dieser Runde, s. Moduldoku internal/asset).
    metadata           JSONB NOT NULL DEFAULT '{}',
    created_by         TEXT NOT NULL,
    updated_by         TEXT NOT NULL,
    row_version        INTEGER NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_type_idx ON assets (type);
CREATE INDEX IF NOT EXISTS assets_status_idx ON assets (status);
-- GIN-Index für Metadaten-/Volltextfilter (B11: "Postgres bevorzugt,
-- keine unnötige zusätzliche Datenbank") — trägt sowohl Metadaten- als
-- auch künftige jsonb_path_ops-Suchen ohne separaten Suchindex-Dienst.
CREATE INDEX IF NOT EXISTS assets_metadata_gin_idx ON assets USING GIN (metadata);

-- Eine AssetVersion ist nach dem Publish unveränderlich (B3: "Eine
-- veröffentlichte Version darf nicht still verändert werden") —
-- durchgesetzt in internal/asset.Store, nicht per SQL-Constraint
-- (dieselbe Ebene wie ProcessVersion, s. 0018_process.sql).
CREATE TABLE IF NOT EXISTS asset_versions (
    id                TEXT PRIMARY KEY,
    asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    parent_version_id TEXT REFERENCES asset_versions(id),
    status            TEXT NOT NULL DEFAULT 'draft',
    change_reason     TEXT NOT NULL DEFAULT '',
    created_by        TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (asset_id, version_number)
);

CREATE INDEX IF NOT EXISTS asset_versions_asset_idx ON asset_versions (asset_id);

ALTER TABLE assets
    ADD CONSTRAINT assets_current_version_fkey
    FOREIGN KEY (current_version_id) REFERENCES asset_versions(id);

-- Representation = eine technische Ausprägung einer AssetVersion (B4:
-- Master/Mezzanine/Proxy/Thumbnail/Audio-Stem/Caption/Transcoded, s.
-- Feldliste dort) — type wie assets.type bewusst TEXT ohne Enum
-- (dieselbe Erweiterbarkeits-Begründung, zusätzlich sucht die
-- Aufgabenstellung selbst noch nach einem besseren Namen für
-- "Mezzanine" — ein freies Feld statt einer verfrüht fixierten Liste).
--
-- storage_provider + uri sind die minimale Storage-Abstraktion (B5) für
-- diese Phase (Domain Model + Persistenz, noch keine I/O-Anbindung) —
-- ein echtes StorageProvider-Interface mit Read/Write/Delete folgt erst,
-- wenn eine erste konkrete Implementierung es braucht (Phase 4).
CREATE TABLE IF NOT EXISTS representations (
    id               TEXT PRIMARY KEY,
    asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
    type             TEXT NOT NULL,
    storage_provider TEXT NOT NULL,
    uri              TEXT NOT NULL,
    format           TEXT NOT NULL DEFAULT '',
    codec            TEXT NOT NULL DEFAULT '',
    container        TEXT NOT NULL DEFAULT '',
    width            INTEGER,
    height           INTEGER,
    frame_rate       DOUBLE PRECISION,
    sample_rate      INTEGER,
    channels         INTEGER,
    bitrate          BIGINT,
    size_bytes       BIGINT,
    checksum         TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS representations_asset_version_idx ON representations (asset_version_id);
CREATE INDEX IF NOT EXISTS representations_type_idx ON representations (type);

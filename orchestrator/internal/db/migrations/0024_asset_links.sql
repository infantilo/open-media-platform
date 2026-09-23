-- Kapitel 21 B10 (Asset<->Workflow-Integration, Nachtrag 277) —
-- Verknüpfung zwischen einer ProcessExecution und den AssetVersions,
-- die sie gelesen/erzeugt hat. Nutzerentscheidung 2026-09-23 (§0
-- Punkt 8, UMSETZUNG.md 21.5): generische Link-API statt automatischer
-- Erkennung oder eines neuen Schritt-Typs — jeder Schritt/Aufrufer
-- verlinkt explizit.
--
-- Bewusst KEIN eigenes Go-Paket in internal/process ODER internal/asset
-- (beide Domänen bleiben laut 21.2 strikt getrennt, kein
-- Cross-Package-Import) — eigenes kleines Paket internal/assetlinks,
-- gleiches additive Muster wie internal/domainaudit (Nachtrag 274):
-- referenziert beide Tabellen per FK, ohne dass die beiden
-- Domänen-Pakete sich gegenseitig kennen müssen.
CREATE TABLE IF NOT EXISTS process_execution_asset_links (
    id                    TEXT PRIMARY KEY,
    process_execution_id  TEXT NOT NULL REFERENCES process_executions(id) ON DELETE CASCADE,
    asset_version_id      TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
    -- "input"/"output" laut Aufgabenstellung, bewusst TEXT ohne
    -- CHECK-Enum (gleiche "extensible types"-Linie wie Asset.Type/
    -- AssetRelationship.Type, s. 0019_assets.sql/0023_asset_collections.sql)
    -- — ein künftiger dritter Rollenwert (z. B. "reference") soll keine
    -- Migration brauchen.
    role                  TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- dieselbe Execution verlinkt dieselbe AssetVersion in derselben
    -- Rolle nicht zweimal (z. B. ein wiederholt aufgerufener Schritt
    -- bei einem Retry, A4) — erneutes Verlinken ist kein neuer Fakt.
    UNIQUE (process_execution_id, asset_version_id, role)
);
CREATE INDEX IF NOT EXISTS process_execution_asset_links_version_idx ON process_execution_asset_links (asset_version_id);

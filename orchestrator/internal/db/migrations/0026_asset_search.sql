-- Kapitel 21 B11 (Volltextsuche, letzter offener Punkt aus Teil B, s.
-- UMSETZUNG.md §21.3/§21.5, Nachtrag 277/284) — Nutzerauftrag "proceed
-- B11". Ersetzt die bisherige reine LIKE-/Client-Substring-Suche
-- (ui/shell/asset-view-logic.ts filterAssets) für Assets durch echte
-- Postgres-Volltextsuche: "keine unnötige zusätzliche Datenbank" laut
-- Aufgabenstellung, tsvector/GIN ist bereits als Vorzugslösung in
-- 0019_assets.sql's metadata-GIN-Index-Kommentar vorgemerkt.
--
-- GENERATED ALWAYS ... STORED statt eines Trigger-gepflegten Feldes:
-- bleibt automatisch konsistent (kein separater Sync-Pfad, der
-- vergessen werden könnte), Postgres erlaubt das hier, weil der
-- Ausdruck mit der fest verdrahteten 'simple'-Konfiguration IMMUTABLE
-- ist. 'simple' bewusst statt 'german'/'english': OMP-Asset-Titel sind
-- Freitext ohne festgelegte Sprache (Broadcast-Metadaten mischen
-- Deutsch/Englisch) — ein falscher Sprach-Stemmer würde Treffer eher
-- verschlucken als finden; 'simple' tokenisiert/normalisiert nur
-- (Kleinschreibung), ohne sprachspezifisch zu raten (§0 Punkt 6-
-- Analogie: nicht raten, wenn es nicht sicher ist).
--
-- Gewichtung (A > B > C > D, s. ts_rank): Titel > Typ > Beschreibung >
-- Metadaten-Werte — ein Treffer im Titel soll höher ranken als einer,
-- der zufällig in einem Metadaten-Freitextfeld steckt.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(type, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(description, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(metadata::text, '')), 'D')
    ) STORED;

CREATE INDEX IF NOT EXISTS assets_search_vector_gin_idx ON assets USING GIN (search_vector);

-- §17 Teil 5 (docs/END-GOAL-FEATURES.md §17.4 Teil 5: "mehrere
-- Versionen desselben Typs parallel im Katalog"): catalog_entries'
-- bisheriger alleiniger Schlüssel `type` reicht nicht mehr — mehrere
-- importierte Einträge desselben Typs mit unterschiedlicher Version
-- sollen nebeneinander bestehen können. Neue Spalte `version`
-- (DEFAULT '' für die bereits vorhandenen, unversionierten Zeilen aus
-- §17 Teil 4, gleiche Bedeutung wie CatalogEntry.Version-Doku: leer =
-- "die eine Version"), Primärschlüssel wird auf das Paar (type,
-- version) erweitert.
ALTER TABLE catalog_entries ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_entries DROP CONSTRAINT IF EXISTS catalog_entries_pkey;
ALTER TABLE catalog_entries ADD PRIMARY KEY (type, version);

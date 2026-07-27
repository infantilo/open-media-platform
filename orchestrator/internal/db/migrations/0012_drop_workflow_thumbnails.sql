-- Entfernt das PGM-Video-Thumbnail-Feature (Migration 0007): die
-- Vorschau in der Workflows-Ansicht zeigt seit 2026-07-27 stattdessen
-- immer eine aus roles/connections generierte Topologie-Grafik
-- (ui/shell/workflows-view.ts #renderTopologyPreview), unabhängig vom
-- Workflow-Status und ohne eigenen Capture-Mechanismus. Die Spalte hat
-- damit keinen Verwender mehr.
ALTER TABLE workflows DROP COLUMN IF EXISTS thumbnail;

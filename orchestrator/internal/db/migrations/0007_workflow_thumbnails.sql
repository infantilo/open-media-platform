-- Thumbnail-Blob je Workflow (Kapitel 12 Teil 6, Unterteil 3,
-- ARCHITECTURE.md §22.3 Punkt 5: "Bild landet als Thumbnail-Blob am
-- Workflow-Objekt, Postgres bytea, D1-Scope — kein MinIO/S3 für so
-- kleine Bilder"). Eigene Spalte statt Teil des JSONB-data-Blobs: ein
-- JPEG-Frame würde als Base64 im JSON aufgebläht (+33%) und bei jedem
-- Put()/Get()/UpdateRuntime() des ganzen Workflow-Objekts unnötig
-- mitgeschleppt, obwohl es nur beim Capture selbst und beim
-- Katalog-Bild-Abruf gebraucht wird (s. Store.SetThumbnail/GetThumbnail).
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS thumbnail BYTEA;

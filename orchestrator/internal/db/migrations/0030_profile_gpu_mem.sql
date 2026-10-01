-- VRAM pro Prozess im Verbrauchsprofil je Node-Typ (Maximum, VRAM ist eine
-- harte Grenze). gpu_mem_samples = 0 heißt "VRAM nie gemessen".
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_mem_max BIGINT NOT NULL DEFAULT 0;
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_mem_samples INTEGER NOT NULL DEFAULT 0;

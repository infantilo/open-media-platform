-- GPU-Auslastung pro Prozess im Verbrauchsprofil je Node-Typ (Prozent einer
-- GPU, aus `nvidia-smi pmon` des Host-Agents). gpu_samples = 0 heißt "GPU-
-- Bedarf nie gemessen" (unbekannt), nicht "nutzt keine GPU" — bestehende
-- Zeilen bleiben deshalb korrekt unbekannt.
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_avg DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_max DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_p95 DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE node_type_profiles ADD COLUMN IF NOT EXISTS gpu_samples INTEGER NOT NULL DEFAULT 0;

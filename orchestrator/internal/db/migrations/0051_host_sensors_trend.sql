-- Host-Temperatur und Leistungsaufnahme im Stundenverlauf (Kapitel 74): Maxima je Stunde, 0 = nicht gemessen.
ALTER TABLE host_metrics_hourly ADD COLUMN IF NOT EXISTS temp_max  DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE host_metrics_hourly ADD COLUMN IF NOT EXISTS power_max DOUBLE PRECISION NOT NULL DEFAULT 0;

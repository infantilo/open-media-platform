-- Stundenverdichtung der Host-Telemetrie (Kapitel 54): 30 Tage Verlauf (CPU/RAM/GPU/Netz) und Live-Anteil der Instanzen.
-- Grundlage der Auto-Kalibrierung der Live-Reserve und der 7-/30-Tage-Ansicht; überlebt Orchestrator-Neustarts.
CREATE TABLE IF NOT EXISTS host_metrics_hourly (
    host_id       TEXT NOT NULL,
    hour          TIMESTAMPTZ NOT NULL,
    cpu_avg       DOUBLE PRECISION NOT NULL DEFAULT 0,
    cpu_max       DOUBLE PRECISION NOT NULL DEFAULT 0,
    mem_avg       DOUBLE PRECISION NOT NULL DEFAULT 0,
    mem_max       DOUBLE PRECISION NOT NULL DEFAULT 0,
    samples       INTEGER NOT NULL DEFAULT 0,
    live_cpu_p95  DOUBLE PRECISION NOT NULL DEFAULT 0,
    live_cpu_avg  DOUBLE PRECISION NOT NULL DEFAULT 0,
    live_cpu_max  DOUBLE PRECISION NOT NULL DEFAULT 0,
    live_mem_max  DOUBLE PRECISION NOT NULL DEFAULT 0,
    live_gpu_max  DOUBLE PRECISION NOT NULL DEFAULT 0,
    gpu_max       DOUBLE PRECISION NOT NULL DEFAULT 0,
    net_max       DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (host_id, hour)
);

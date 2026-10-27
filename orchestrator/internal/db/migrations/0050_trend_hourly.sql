-- Stundenverlauf für Baseline und Trends (Kap. 72.11): CPU, Speicher, offene Dateien, Threads je Instanz (nach Typ und Name, damit der Verlauf
-- einen Neustart überlebt) und die Prozesswerte des Orchestrators. Hosts nutzen host_metrics_hourly (Migration 0043).
CREATE TABLE IF NOT EXISTS trend_hourly (
    subject  TEXT NOT NULL,
    metric   TEXT NOT NULL,
    hour     TIMESTAMPTZ NOT NULL,
    label    TEXT NOT NULL DEFAULT '',
    avg      DOUBLE PRECISION NOT NULL DEFAULT 0,
    max      DOUBLE PRECISION NOT NULL DEFAULT 0,
    samples  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, metric, hour)
);
CREATE INDEX IF NOT EXISTS trend_hourly_hour_idx ON trend_hourly (hour);

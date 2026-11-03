-- Datenbank-Wartung: Tabellen mit ständigem Einfügen/Löschen (Logs, Outbox,
-- Audit, Trends, As-run, Zeitleiste) bekommen engere Autovacuum-Schwellen.
-- Der Standard (20 % der Tabelle) ist für sie zu träge: bei Millionen Zeilen
-- liefe der Müll erst nach hunderttausenden toten Zeilen weg.
ALTER TABLE logs                SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE outbox_events       SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE audit_log           SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE domain_audit_log    SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE timeline_events     SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE playout_asrun       SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE trend_hourly        SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE host_metrics_hourly SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE workflow_runs       SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

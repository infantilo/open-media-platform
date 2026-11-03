-- E-Mail-Alarmierung: Empfängerregeln nach Alarmart und Schweregrad (Liste von Regeln als JSON).
ALTER TABLE alert_mail_config ADD COLUMN IF NOT EXISTS routes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE alert_mail_config ALTER COLUMN to_addrs SET DEFAULT '';

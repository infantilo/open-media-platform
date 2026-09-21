-- Quittierte/maskierte Alarme (Nachtrag 243). Ein Eintrag je Alarm-Key;
-- gilt nur, solange der Fingerprint des aktuell anstehenden Alarms mit
-- `fingerprint` übereinstimmt (Wiederauftreten/Statuswechsel ändert ihn
-- und macht den Alarm wieder laut) und `expires_at` nicht überschritten
-- ist. Die Alarme selbst werden weiterhin in der UI aus den bestehenden
-- Quellen abgeleitet — hier steht nur der geteilte Quittierstand.
CREATE TABLE IF NOT EXISTS alarm_acks (
    key         TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('ack', 'mask')),
    comment     TEXT NOT NULL DEFAULT '',
    username    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ
);

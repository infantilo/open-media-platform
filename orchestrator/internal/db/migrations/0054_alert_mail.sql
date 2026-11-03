-- E-Mail-Alarmierung (Kap. 83): eine Zeile, in der Oberfläche einstellbar.
-- Das Kennwort liegt nur verschlüsselt (AES-256-GCM, Schlüssel OMP_STORAGE_SECRET_KEY) hier.
CREATE TABLE IF NOT EXISTS alert_mail_config (
    id           INT PRIMARY KEY CHECK (id = 1),
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    host         TEXT NOT NULL,
    port         INT  NOT NULL DEFAULT 0,
    security     TEXT NOT NULL DEFAULT 'starttls',
    username     TEXT NOT NULL DEFAULT '',
    password_enc BYTEA,
    from_addr    TEXT NOT NULL DEFAULT '',
    to_addrs     TEXT NOT NULL,
    updated_by   TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

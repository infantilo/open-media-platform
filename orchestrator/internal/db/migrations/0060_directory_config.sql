-- Einstellungen der Active-Directory-/LDAP-Anbindung, in der Oberfläche pflegbar (Nutzerauftrag 2026-11-11).
-- Eine Zeile; ist keine gespeichert, gelten die Umgebungsvariablen OMP_LDAP_*. Das Dienstkonto-Kennwort liegt
-- AES-256-GCM-verschlüsselt (Schlüssel OMP_STORAGE_SECRET_KEY, wie Speicher-Backends und Mail-Zugang).
CREATE TABLE IF NOT EXISTS directory_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    enabled       BOOLEAN NOT NULL DEFAULT false,
    urls          TEXT NOT NULL DEFAULT '',
    start_tls     BOOLEAN NOT NULL DEFAULT false,
    allow_plain   BOOLEAN NOT NULL DEFAULT false,
    ca_pem        TEXT NOT NULL DEFAULT '',
    base_dn       TEXT NOT NULL DEFAULT '',
    bind_dn       TEXT NOT NULL DEFAULT '',
    password_enc  BYTEA,
    user_filter   TEXT NOT NULL DEFAULT '',
    user_attr     TEXT NOT NULL DEFAULT '',
    group_base_dn TEXT NOT NULL DEFAULT '',
    group_filter  TEXT NOT NULL DEFAULT '',
    required_group TEXT NOT NULL DEFAULT '',
    timeout_s     INTEGER NOT NULL DEFAULT 8,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

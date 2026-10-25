-- Schlüssel für signierte Host-Kommandos (Audit 2026-10-23 B2, jobwire/cmdauth.go): je Host ein geheimer Schlüssel.
-- provisioned_at: der Host-Agent kennt ihn (bei der Registrierung ausgeliefert oder per provision-key übergeben).
CREATE TABLE IF NOT EXISTS host_command_keys (
    host_id         TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    provisioned_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

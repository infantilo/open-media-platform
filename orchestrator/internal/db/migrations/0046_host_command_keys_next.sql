-- Schlüsselrotation (Audit 2026-10-23 B2): der neue Schlüssel steht hier, bis der Host-Agent ihn bestätigt hat.
ALTER TABLE host_command_keys ADD COLUMN IF NOT EXISTS next_key TEXT;

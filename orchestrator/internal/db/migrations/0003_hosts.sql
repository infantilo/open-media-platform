-- Remote-Host-Erkennung & Host-Agent (ARCHITECTURE.md §18, UMSETZUNG.md
-- D6 Teil 1: Bootstrap + Telemetrie, kein Kommandokanal/Placement in
-- dieser Runde).
--
-- host_bootstrap_tokens: ein Admin erzeugt pro neuem Host ein einmaliges,
-- kurzlebiges Token (§18.3 Punkt 1); gespeichert wird nur der SHA-256-Hash
-- (gleiches Prinzip wie users.password_hash — ein DB-Leck legt keine
-- gültigen Tokens offen), nicht das Token selbst. used_at NULL = noch
-- nicht eingelöst; ein Token ist nach dem ersten erfolgreichen
-- /api/v1/hosts/register-Aufruf verbraucht (§18.3 Punkt 3).
CREATE TABLE IF NOT EXISTS host_bootstrap_tokens (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

-- hosts: ein erfolgreich registrierter omp-host-agent (§18.1). capabilities
-- ist ein opakes JSON-Blob (Hostname/uname-Infos, künftig I/O-Karten-
-- Inventar, §18.4) — der Orchestrator interpretiert nur die Felder, die er
-- gerade braucht, kein starres Schema (gleiche Opak-Speicherung wie
-- layouts.data, D1).
CREATE TABLE IF NOT EXISTS hosts (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    hostname      TEXT NOT NULL,
    capabilities  JSONB NOT NULL DEFAULT '{}',
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
